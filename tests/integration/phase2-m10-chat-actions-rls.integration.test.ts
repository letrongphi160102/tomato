import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as readConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/read/route';
import {
  DELETE as conversationDelete,
  GET as conversationDetailGet,
} from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import {
  GET as messageDetailGet,
  PATCH as messageEditPatch,
} from '@/app/api/v1/messages/[messagePublicId]/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import { authIdentities, messageUserDeletions, messages, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
} from '@/core/realtime';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  reEncryptEditedDirectMessage,
} from '@/lib/e2ee';
import {
  AuthRepository,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';
import {
  ChatRepository,
  ChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
} from '@/modules/chat';
import {
  NotificationRepository,
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
} from '@/modules/notifications';
import {
  PresenceRepository,
  PresenceService,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
} from '@/modules/presence';
import {
  SocialRepository,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
} from '@/modules/social';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 160;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 200) + 10}`;
}

function makeUniqueTag(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class SilentEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
}

function extractCookies(response: Response, previous: CookieJar = {}): CookieJar {
  const next: CookieJar = { ...previous };
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(';')[0] ?? '';
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();
    const isCleared = /Max-Age=0/i.test(header) || value === '';

    if (name === 'tomato_at' || name === '__Host-tomato_at') {
      next.at = isCleared ? undefined : value;
    } else if (name === 'tomato_rt' || name === '__Host-tomato_rt') {
      next.rt = isCleared ? undefined : value;
    } else if (name === 'tomato_csrf' || name === '__Host-tomato_csrf') {
      next.csrf = isCleared ? undefined : value;
    }
  }
  return next;
}

function createHeaders(
  jar: CookieJar,
  ip: string,
  options: { includeCsrf?: boolean; json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    origin: getTestOrigin(),
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': ip,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
  };
  const cookieParts: string[] = [];
  if (jar.at) cookieParts.push(`tomato_at=${jar.at}`);
  if (jar.rt) cookieParts.push(`tomato_rt=${jar.rt}`);
  if (jar.csrf) cookieParts.push(`tomato_csrf=${jar.csrf}`);
  if (cookieParts.length > 0) {
    headers.cookie = cookieParts.join('; ');
  }
  if (options.includeCsrf && jar.csrf) {
    headers[CSRF_HEADER_NAME] = jar.csrf;
  }
  if (options.json) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

interface SeededUser {
  readonly id: string;
  readonly publicId: string;
  readonly handle: string;
  readonly ip: string;
  jar: CookieJar;
}

const createdUserIds: string[] = [];
const TEST_PASSWORD = 'TomatoPhase2_M10_Password!99';

async function seedAndLoginUser(prefix: string, fullName: string): Promise<SeededUser> {
  const db = getDb();
  const tag = makeUniqueTag(prefix);
  const id = generateUuidV7();
  const publicId = generatePublicId();
  const email = `${tag}@tomato.test`;
  const handle = tag.toLowerCase();
  const now = new Date();
  const hashed = await hashPassword(TEST_PASSWORD);

  await db.insert(users).values({
    id,
    publicId,
    username: handle,
    handle,
    handleNormalized: handle,
    fullName,
    bio: '',
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    gender: 'other',
    dateOfBirth: '1999-05-15',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(authIdentities).values({
    id: generateUuidV7(),
    userId: id,
    provider: 'email_password',
    identifierNormalized: email.toLowerCase(),
    passwordHash: hashed.hash,
    pepperVersion: hashed.pepperVersion,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  createdUserIds.push(id);

  const ip = nextTestIp();
  const loginRes = await loginPost(
    new Request(`${getTestOrigin()}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        origin: getTestOrigin(),
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': ip,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const jar = extractCookies(loginRes);

  return { id, publicId, handle, ip, jar };
}

describe('Integration M10: PostgreSQL RLS `message_user_deletions` (Non-BYPASSRLS), Đồng hồ PostgreSQL 5 phút, Xóa 1 phía & Xóa đoạn chat không lộ Đã xem giả', () => {
  beforeEach(() => {
    clearMemoryKeystoreForTesting();
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m10:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const rateLimiter = new RateLimiter(redis, { keyPrefix });
    const auditLogService = new AuditLogService();
    const authRepo = new AuthRepository();
    const sessionService = new SessionService({ repository: authRepo, rateLimiter });
    const authService = new AuthService({
      repository: authRepo,
      sessionService,
      rateLimiter,
      loginProtection: new LoginBruteForceGuard(redis, { keyPrefix: `${keyPrefix}:bf` }),
      emailProvider: new SilentEmailProvider(),
      captchaProvider: {
        provider: 'turnstile',
        verify: async () => ({ success: true, errorCodes: [] }),
      },
      auditLogService,
      minLoginFailureResponseMs: 0,
      minResendResponseMs: 0,
    });

    const realtimeAdapter = new InMemoryRealtimeAdapter({ isolated: true });
    const notificationService = new NotificationService({
      repository: new NotificationRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
    });
    const presenceService = new PresenceService({
      repository: new PresenceRepository(),
      redis,
      rateLimiter,
    });
    const socialService = new SocialService({
      repository: new SocialRepository(),
      rateLimiter,
      auditLogService,
      notificationService,
      presenceService,
    });
    const chatService = new ChatService({
      repository: new ChatRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
      notificationService,
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setRealtimeProviderForTesting(realtimeAdapter);
    setNotificationServiceForTesting(notificationService);
    setPresenceServiceForTesting(presenceService);
    setSocialServiceForTesting(socialService);
    setChatServiceForTesting(chatService);
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await getDb().delete(users).where(inArray(users.id, createdUserIds));
      }
    } finally {
      resetSessionServiceForTesting();
      resetAuthServiceForTesting();
      resetRealtimeProviderForTesting();
      resetNotificationServiceForTesting();
      resetPresenceServiceForTesting();
      resetSocialServiceForTesting();
      resetChatServiceForTesting();
      await closeRedisClient();
      await closeDatabasePool();
    }
  });

  it('kiểm chứng PostgreSQL RLS trên `message_user_deletions` (role NOBYPASSRLS), đồng hồ PostgreSQL NOW() 5 phút, tombstone NULL, xóa 1 phía & xóa hội thoại không lộ Đã xem giả', async () => {
    const origin = getTestOrigin();
    const db = getDb();

    const alice = await seedAndLoginUser('m10_a', 'Alice M10');
    const bob = await seedAndLoginUser('m10_b', 'Bob M10');
    const david = await seedAndLoginUser('m10_d', 'David M10');

    // Đảm bảo role kiểm thử RLS không có BYPASSRLS có quyền trên bảng mới `message_user_deletions` (tuần tự hóa bằng advisory lock).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(727012)`);
      await tx.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tomato_rls_verify_role') THEN
            CREATE ROLE tomato_rls_verify_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
        END
        $$;
      `);
      await tx.execute(sql`GRANT USAGE ON SCHEMA public TO tomato_rls_verify_role`);
      await tx.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversations", "conversation_participants", "messages", "message_user_deletions" TO tomato_rls_verify_role`,
      );
      await tx.execute(
        sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"(), "public"."app_is_conversation_member"(uuid) TO tomato_rls_verify_role`,
      );
    });

    // Bob follow Alice để hội thoại A-B vào thẳng `primary`.
    const followRes = await followPost(
      new Request(`${origin}/api/v1/social/follow/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    expect([200, 201]).toContain(followRes.status);

    // Đăng ký khóa E2EE của Alice và Bob.
    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);

    for (const [u, mat] of [
      [alice, aliceMat],
      [bob, bobMat],
    ] as const) {
      const regRes = await e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: createHeaders(u.jar, u.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({
            identityPublicKeyJwk: mat.identityPublicKeyJwk,
            signingPublicKeyJwk: mat.signingPublicKeyJwk,
            keyFingerprint: mat.keyFingerprint,
          }),
        }),
      );
      expect(regRes.status).toBe(200);
    }

    // Alice tạo hội thoại với Bob và gửi 4 tin nhắn.
    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ recipientPublicId: bob.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    async function sendFrom(
      sender: SeededUser,
      senderMat: typeof aliceMat,
      recipientMat: typeof bobMat,
      clientMsgId: string,
      text: string,
    ) {
      const envelope = await encryptDirectMessage({
        conversationPublicId: convId,
        senderPublicId: sender.publicId,
        clientMsgId,
        plaintext: text,
        senderDevice: senderMat,
        recipientDevices: [
          {
            devicePublicId: recipientMat.devicePublicId,
            keyFingerprint: recipientMat.keyFingerprint,
            identityPublicKeyJwk: recipientMat.identityPublicKeyJwk,
            signingPublicKeyJwk: recipientMat.signingPublicKeyJwk,
          },
        ],
      });
      const res = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          method: 'POST',
          headers: createHeaders(sender.jar, sender.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({
            clientMsgId,
            messageType: 'text',
            ciphertext: envelope.ciphertext,
            cryptoHeader: envelope.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { message: { public_id: string; seq: number } };
      return { publicId: body.message.public_id, seq: body.message.seq, clientMsgId, envelope };
    }

    const msg1 = await sendFrom(alice, aliceMat, bobMat, 'pg_m10_1', 'Tin 1 - sửa ở phút 4');
    const msg2 = await sendFrom(alice, aliceMat, bobMat, 'pg_m10_2', 'Tin 2 - thu hồi ở phút 4');
    const msg3 = await sendFrom(alice, aliceMat, bobMat, 'pg_m10_3', 'Tin 3 - quá 5 phút');
    const msg4 = await sendFrom(alice, aliceMat, bobMat, 'pg_m10_4', 'Tin 4 - xóa 1 phía');

    // 1. Lùi `created_at` trong PostgreSQL thật:
    //    - msg1 & msg2: `NOW() - 240 seconds` (phút thứ 4) -> sửa & thu hồi THÀNH CÔNG.
    //    - msg3: `NOW() - 301 seconds` (phút thứ 5 + 1 giây) -> sửa & thu hồi BỊ TỪ CHỐI 403!
    await db
      .update(messages)
      .set({ createdAt: sql`NOW() - interval '240 seconds'` })
      .where(inArray(messages.publicId, [msg1.publicId, msg2.publicId]));
    await db
      .update(messages)
      .set({ createdAt: sql`NOW() - interval '301 seconds'` })
      .where(eq(messages.publicId, msg3.publicId));

    const editEnv1 = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: msg1.clientMsgId,
      plaintext: 'Tin 1 đã sửa thành công ở phút 4',
      senderDevice: aliceMat,
      recipientDevices: [
        {
          devicePublicId: bobMat.devicePublicId,
          keyFingerprint: bobMat.keyFingerprint,
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
        },
      ],
      previousIv: msg1.envelope.cryptoHeader.iv,
    });

    const editAt4MinRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msg1.publicId}`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ciphertext: editEnv1.ciphertext,
          cryptoHeader: editEnv1.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msg1.publicId }) },
    );
    expect(editAt4MinRes.status).toBe(200);

    const recallAt4MinRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msg2.publicId}/recall`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msg2.publicId }) },
    );
    expect(recallAt4MinRes.status).toBe(200);

    // Xác nhận trực tiếp trong PostgreSQL: `ciphertext` và `crypto_header` đã là NULL sau khi thu hồi!
    const dbMsg2 = await db
      .select()
      .from(messages)
      .where(eq(messages.publicId, msg2.publicId))
      .limit(1);
    expect(dbMsg2[0]?.ciphertext).toBeNull();
    expect(dbMsg2[0]?.cryptoHeader).toBeNull();
    expect(dbMsg2[0]?.recalledAt).not.toBeNull();

    // Quá 5 phút + 1 giây -> PostgreSQL/Server từ chối cả Sửa lẫn Thu hồi!
    const editEnv3 = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: msg3.clientMsgId,
      plaintext: 'Quá hạn',
      senderDevice: aliceMat,
      recipientDevices: [
        {
          devicePublicId: bobMat.devicePublicId,
          keyFingerprint: bobMat.keyFingerprint,
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
        },
      ],
      previousIv: msg3.envelope.cryptoHeader.iv,
    });
    const editExpiredRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${msg3.publicId}`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          ciphertext: editEnv3.ciphertext,
          cryptoHeader: editEnv3.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: msg3.publicId }) },
    );
    expect(editExpiredRes.status).toBe(403);

    const recallExpiredRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${msg3.publicId}/recall`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: msg3.publicId }) },
    );
    expect(recallExpiredRes.status).toBe(403);

    // 2. Xóa 1 phía (`DELETE /for-me`) + kiểm chứng PostgreSQL RLS thật trên `message_user_deletions` với `NOBYPASSRLS`!
    const del4Res = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${msg4.publicId}/for-me`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: msg4.publicId }) },
    );
    expect(del4Res.status).toBe(200);
    const del4Body = (await del4Res.json()) as {
      nextLastMessage: { public_id: string } | null;
    };
    expect(del4Body.nextLastMessage?.public_id).toBe(msg3.publicId);

    const dbMsg4Row = (
      await db.select().from(messages).where(eq(messages.publicId, msg4.publicId)).limit(1)
    )[0]!;

    // Dưới role `tomato_rls_verify_role` (`NOBYPASSRLS`):
    // - Alice đọc được dòng `message_user_deletions` của chính mình (không đệ quy).
    await withRlsContext(alice.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const ownRows = await tx
        .select()
        .from(messageUserDeletions)
        .where(eq(messageUserDeletions.messageId, dbMsg4Row.id));
      expect(ownRows).toHaveLength(1);
    });

    // - Bob và David đọc `message_user_deletions` KHÔNG thấy dòng nào của Alice,
    //   và cố INSERT hộ `user_id = alice.id` bị PostgreSQL RLS chặn lỗi!
    for (const other of [bob, david]) {
      await withRlsContext(other.id, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
        const leaked = await tx
          .select()
          .from(messageUserDeletions)
          .where(eq(messageUserDeletions.userId, alice.id));
        expect(leaked).toHaveLength(0);

        await expect(
          tx.insert(messageUserDeletions).values({
            messageId: dbMsg4Row.id,
            userId: alice.id,
          }),
        ).rejects.toThrow();
      });
    }

    // - Dưới role `tomato_rls_verify_role`, Bob cố UPDATE trực tiếp dòng `messages` của Alice -> 0 dòng bị ảnh hưởng!
    await withRlsContext(bob.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const forgedUpdate = await tx
        .update(messages)
        .set({ editCount: 5 })
        .where(eq(messages.id, dbMsg4Row.id))
        .returning();
      expect(forgedUpdate).toHaveLength(0);
    });

    // Alice không thấy msg4 (preview cột trái là msg3); Bob vẫn thấy đủ 4 tin nhắn!
    const [aliceGet4Res, bobListMsgsRes] = await Promise.all([
      messageDetailGet(
        new Request(`${origin}/api/v1/messages/${msg4.publicId}`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
        { params: Promise.resolve({ messagePublicId: msg4.publicId }) },
      ),
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          headers: createHeaders(bob.jar, bob.ip),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);
    expect(aliceGet4Res.status).toBe(404);
    expect(((await bobListMsgsRes.json()) as { items: unknown[] }).items).toHaveLength(4);

    // 3. Điều chỉnh (2): Bob đọc đến tin 1 (`lastReadSeq = 1`), còn tin 2, 3, 4 CHƯA ĐỌC -> unread = 1.
    //    Sau đó Bob Xóa đoạn chat (`DELETE /conversations/:id`):
    //    - `unreadConversationsCount` của Bob giảm sạch về 0.
    //    - `last_read_seq` của Bob KHÔNG tăng lên 4 -> Alice tải lại vẫn chỉ thấy `peerLastReadSeq = 1` (không lộ "Đã xem" giả!).
    await readConversationPost(
      new Request(`${origin}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ lastReadSeq: 1 }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );

    const bobDeleteConvRes = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(bobDeleteConvRes.status).toBe(200);
    const bobDeleteConvBody = (await bobDeleteConvRes.json()) as {
      clearedBeforeSeq: number;
      unreadConversationsCount: number;
    };
    expect(bobDeleteConvBody.clearedBeforeSeq).toBe(4);
    expect(bobDeleteConvBody.unreadConversationsCount).toBe(0);

    // Kiểm tra Alice vẫn chỉ thấy `peerLastReadSeq = 1` (KHÔNG phải 4!).
    const aliceDetailCheck = await conversationDetailGet(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(
      (
        (await aliceDetailCheck.json()) as {
          conversation: { peerLastReadSeq: number | null };
        }
      ).conversation.peerLastReadSeq,
    ).toBe(1);

    // 4. Điều chỉnh (1): Bob mở lại direct (`last_seq === cleared_before_seq = 4`) -> trả về `lastMessage: null` sạch sẽ.
    const bobReopenRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ recipientPublicId: alice.publicId }),
      }),
    );
    expect(bobReopenRes.status).toBe(200);
    expect(
      ((await bobReopenRes.json()) as { conversation: { lastMessage: unknown } }).conversation
        .lastMessage,
    ).toBeNull();

    // Bob xóa lại lần nữa rồi tự chủ động nhắn tin thứ 5 -> `hidden_at` của chính Bob (actorParticipant) tự gỡ `NULL`!
    await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );

    const msg5 = await sendFrom(bob, bobMat, aliceMat, 'pg_m10_5', 'Bob chủ động nhắn lại');
    expect(msg5.seq).toBe(5);

    const [bobListAfterOwnMsgRes, bobMsgsAfterOwnMsgRes] = await Promise.all([
      conversationsListGet(
        new Request(`${origin}/api/v1/conversations?tab=primary`, {
          headers: createHeaders(bob.jar, bob.ip),
        }),
      ),
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          headers: createHeaders(bob.jar, bob.ip),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);
    expect(((await bobListAfterOwnMsgRes.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(
      ((await bobMsgsAfterOwnMsgRes.json()) as { items: Array<{ seq: number }> }).items.map(
        (m) => m.seq,
      ),
    ).toEqual([5]);

    // Alice xóa đoạn chat (`cleared_before_seq = 5`), sau đó Bob gửi tin thứ 6 ->
    // `hidden_at` của Alice (peerParticipant) tự gỡ `NULL`, Alice chỉ thấy tin 6 (`seq > 5`) & unread = 1,
    // và khi Alice đọc tin 6, Bob nhận `peerLastReadSeq = 6` bình thường!
    await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );

    const msg6 = await sendFrom(bob, bobMat, aliceMat, 'pg_m10_6', 'Tin mới mở lại cho Alice');
    expect(msg6.seq).toBe(6);

    const [aliceListReopenedRes, aliceMsgsReopenedRes] = await Promise.all([
      conversationsListGet(
        new Request(`${origin}/api/v1/conversations?tab=primary`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
      ),
      messagesGet(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      ),
    ]);
    const aliceListReopened = (await aliceListReopenedRes.json()) as {
      items: unknown[];
      unreadConversationsCount: number;
    };
    expect(aliceListReopened.items).toHaveLength(1);
    expect(aliceListReopened.unreadConversationsCount).toBe(1);
    expect(
      ((await aliceMsgsReopenedRes.json()) as { items: Array<{ seq: number }> }).items.map(
        (m) => m.seq,
      ),
    ).toEqual([6]);

    // Hồi quy Trạng thái Đã xem đối xứng: Alice đọc tin 6 -> unread về 0, Bob thấy `peerLastReadSeq = 6`.
    const aliceRead6Res = await readConversationPost(
      new Request(`${origin}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ lastReadSeq: 6 }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(aliceRead6Res.status).toBe(200);
    expect(
      ((await aliceRead6Res.json()) as { unreadConversationsCount: number })
        .unreadConversationsCount,
    ).toBe(0);

    const bobDetailAfterAliceRead6 = await conversationDetailGet(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(
      (
        (await bobDetailAfterAliceRead6.json()) as {
          conversation: { peerLastReadSeq: number | null };
        }
      ).conversation.peerLastReadSeq,
    ).toBe(6);
  });
});
