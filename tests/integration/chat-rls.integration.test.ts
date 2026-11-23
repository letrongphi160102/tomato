import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as acceptConversationPost } from '@/app/api/v1/conversations/[conversationPublicId]/accept/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { PUT as e2eeBackupPut } from '@/app/api/v1/e2ee/backup/route';
import { GET as e2eeUserKeysGet } from '@/app/api/v1/e2ee/users/[userPublicId]/keys/route';
import { POST as presenceHeartbeatPost } from '@/app/api/v1/presence/heartbeat/route';
import { POST as presenceQueryPost } from '@/app/api/v1/presence/query/route';
import { POST as blockPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import {
  authIdentities,
  conversationParticipants,
  conversations,
  messages,
  userE2eeKeyBackups,
  users,
} from '@/core/db/schema';
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
  decryptDirectMessage,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  importAndStoreBootstrapKeyMaterial,
  listLocalDeviceKeyMaterials,
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
  buildPresenceRedisKey,
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

let ipCounter = 110;
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
const TEST_PASSWORD = 'TomatoPhase2_M9_Password!99';

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

describe('Integration M9: PostgreSQL RLS (Non-BYPASSRLS Role), Non-Recursive Policies, Direct Pair Key & Presence Sync', () => {
  beforeEach(() => {
    clearMemoryKeystoreForTesting();
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m9:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
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
      const redis = getRedisClient();
      if (createdUserIds.length > 0) {
        await redis.del(...createdUserIds.map((uid) => buildPresenceRedisKey(uid)));
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

  it('kiểm chứng PostgreSQL RLS thực tế bằng role không có BYPASSRLS (`SET LOCAL ROLE`) chặn tuyệt đối User D và không bị lỗi đệ quy trên conversation_participants', async () => {
    const origin = getTestOrigin();
    const db = getDb();

    const alice = await seedAndLoginUser('m9_rls_a', 'Alice RLS');
    const bob = await seedAndLoginUser('m9_rls_b', 'Bob RLS');
    const davidOutsider = await seedAndLoginUser('m9_rls_d', 'David Outsider RLS');

    // Khởi tạo role kiểm thử RLS không có quyền superuser và không có BYPASSRLS.
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tomato_rls_verify_role') THEN
          CREATE ROLE tomato_rls_verify_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO tomato_rls_verify_role`);
    await db.execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversations", "conversation_participants", "messages", "user_e2ee_devices", "user_e2ee_key_backups" TO tomato_rls_verify_role`,
    );
    await db.execute(
      sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"(), "public"."app_is_conversation_member"(uuid) TO tomato_rls_verify_role`,
    );

    // 1. Alice và Bob đăng ký khóa E2EE + Alice lưu bản sao lưu PIN.
    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);

    const regA = await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: aliceMat.identityPublicKeyJwk,
          signingPublicKeyJwk: aliceMat.signingPublicKeyJwk,
          keyFingerprint: aliceMat.keyFingerprint,
        }),
      }),
    );
    expect(regA.status).toBe(200);

    const regB = await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
          keyFingerprint: bobMat.keyFingerprint,
        }),
      }),
    );
    expect(regB.status).toBe(200);

    const putBackupRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          encryptedKeyBlob: 'a'.repeat(64),
          kdfSalt: 'b'.repeat(24),
          kdfParams: { alg: 'PBKDF2-SHA256', iterations: 600_000 },
          iv: 'c'.repeat(16),
          keyFingerprint: aliceMat.keyFingerprint,
          version: 1,
        }),
      }),
    );
    expect(putBackupRes.status).toBe(200);

    // 2. Alice và Bob khởi tạo hội thoại đồng thời (kiểm tra direct_pair_key chống race condition).
    const [convRes1, convRes2] = await Promise.all([
      directConversationPost(
        new Request(`${origin}/api/v1/conversations/direct`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({ recipientPublicId: bob.publicId }),
        }),
      ),
      directConversationPost(
        new Request(`${origin}/api/v1/conversations/direct`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
          body: JSON.stringify({ recipientPublicId: bob.publicId }),
        }),
      ),
    ]);
    expect([200, 201]).toContain(convRes1.status);
    expect([200, 201]).toContain(convRes2.status);

    const convBody1 = (await convRes1.json()) as { conversation: { public_id: string } };
    const convBody2 = (await convRes2.json()) as { conversation: { public_id: string } };
    expect(convBody1.conversation.public_id).toBe(convBody2.conversation.public_id);
    const convPublicId = convBody1.conversation.public_id;

    // 3. Alice gửi tin nhắn E2EE cho Bob.
    const envelope = await encryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alice.publicId,
      clientMsgId: 'msg_rls_001',
      plaintext: 'Tin nhắn kiểm thử RLS',
      senderDevice: aliceMat,
      recipientDevices: [
        {
          devicePublicId: bobMat.devicePublicId,
          keyFingerprint: bobMat.keyFingerprint,
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
        },
      ],
    });

    const sendRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'msg_rls_001',
          messageType: 'text',
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(sendRes.status).toBe(201);

    // 4. Kiểm chứng RLS với SET LOCAL ROLE tomato_rls_verify_role:
    //    - Với ngữ cảnh của Alice (thành viên): đọc được hội thoại, 2 thành viên (không đệ quy!), tin nhắn và backup của Alice.
    await withRlsContext(alice.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);

      const visibleConvs = await tx
        .select()
        .from(conversations)
        .where(sql`${conversations.publicId} = ${convPublicId}`);
      expect(visibleConvs).toHaveLength(1);

      const visibleParts = await tx
        .select()
        .from(conversationParticipants)
        .where(sql`${conversationParticipants.conversationId} = ${visibleConvs[0]!.id}`);
      expect(visibleParts).toHaveLength(2);

      const visibleMsgs = await tx
        .select()
        .from(messages)
        .where(sql`${messages.conversationId} = ${visibleConvs[0]!.id}`);
      expect(visibleMsgs).toHaveLength(1);

      const visibleBackups = await tx
        .select()
        .from(userE2eeKeyBackups)
        .where(sql`${userE2eeKeyBackups.userId} = ${alice.id}`);
      expect(visibleBackups).toHaveLength(1);
    });

    //    - Với ngữ cảnh của David (User D - người ngoài cuộc) dưới role tomato_rls_verify_role:
    //      Mọi truy vấn SELECT (kể cả không có mệnh đề WHERE lọc user) tới hội thoại A-B đều bị PostgreSQL RLS chặn trả về 0 dòng!
    await withRlsContext(davidOutsider.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);

      const leakedConvs = await tx
        .select()
        .from(conversations)
        .where(sql`${conversations.publicId} = ${convPublicId}`);
      expect(leakedConvs).toHaveLength(0);

      const leakedParts = await tx
        .select()
        .from(conversationParticipants)
        .where(sql`${conversationParticipants.userId} IN (${alice.id}, ${bob.id})`);
      expect(leakedParts).toHaveLength(0);

      const leakedMsgs = await tx
        .select()
        .from(messages)
        .where(sql`${messages.clientMsgId} = 'msg_rls_001'`);
      expect(leakedMsgs).toHaveLength(0);

      const leakedBackups = await tx
        .select()
        .from(userE2eeKeyBackups)
        .where(sql`${userE2eeKeyBackups.userId} = ${alice.id}`);
      expect(leakedBackups).toHaveLength(0);
    });
  });

  it('ẩn trạng thái hoạt động (Presence) khi hội thoại ở trạng thái pending, mở khóa sau khi accept và khóa lại với 404 khi Block', async () => {
    const origin = getTestOrigin();
    const alice = await seedAndLoginUser('m9_pres_a', 'Alice Chat Presence');
    const bob = await seedAndLoginUser('m9_pres_b', 'Bob Chat Presence');

    // Cả hai gửi heartbeat online nhưng CHƯA follow nhau.
    await presenceHeartbeatPost(
      new Request(`${origin}/api/v1/presence/heartbeat`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    await presenceHeartbeatPost(
      new Request(`${origin}/api/v1/presence/heartbeat`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );

    // Alice mở hội thoại với Bob -> Bob ở trạng thái `pending`.
    const createRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ recipientPublicId: bob.publicId }),
      }),
    );
    expect(createRes.status).toBe(201);
    const convPublicId = ((await createRes.json()) as { conversation: { public_id: string } })
      .conversation.public_id;

    // 0. Khi mới bấm "Nhắn tin" nhưng CHƯA gửi bất kỳ tin nhắn nào (last_seq = 0):
    //    Danh sách hộp thư Chính (`tab=primary`) của Alice KHÔNG được hiển thị đoạn chat trống.
    const emptyPrimaryListRes = await conversationsListGet(
      new Request(`${origin}/api/v1/conversations?tab=primary`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    expect(emptyPrimaryListRes.status).toBe(200);
    const emptyPrimaryList = (await emptyPrimaryListRes.json()) as {
      items: Array<{ public_id: string }>;
    };
    expect(emptyPrimaryList.items.some((c) => c.public_id === convPublicId)).toBe(false);

    // 0b. Ngay cả khi Bob CHƯA từng đăng nhập / đăng ký khóa thiết bị sau khi deploy M9,
    //     Alice gọi GET /api/v1/e2ee/users/:bob/keys vẫn nhận được khóa P-256 hộp thư mặc định của Bob,
    //     mã hóa & gửi tin nhắn được ngay, và khi Bob đăng nhập sau đó sẽ giải mã đọc được tin nhắn!
    const bobKeysBeforeLoginRes = await e2eeUserKeysGet(
      new Request(`${origin}/api/v1/e2ee/users/${bob.publicId}/keys`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(bobKeysBeforeLoginRes.status).toBe(200);
    const bobKeysBeforeLogin = (await bobKeysBeforeLoginRes.json()) as {
      devices: Array<{
        devicePublicId: string;
        keyFingerprint: string;
        identityPublicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
        signingPublicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      }>;
    };
    expect(bobKeysBeforeLogin.devices).toHaveLength(1);

    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    const offlineMsgEnvelope = await encryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alice.publicId,
      clientMsgId: 'msg_offline_bob_01',
      plaintext: 'Tin nhắn gửi khi Bob chưa mở web lần nào',
      senderDevice: aliceDevice,
      recipientDevices: bobKeysBeforeLogin.devices,
    });

    const sendToOfflineBobRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          clientMsgId: 'msg_offline_bob_01',
          messageType: 'text',
          ciphertext: offlineMsgEnvelope.ciphertext,
          cryptoHeader: offlineMsgEnvelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(sendToOfflineBobRes.status).toBe(201);

    // Sau khi đã gửi ít nhất 1 tin nhắn (last_seq = 1), hội thoại mới xuất hiện trong tab Chính của Alice.
    const primaryListAfterSendRes = await conversationsListGet(
      new Request(`${origin}/api/v1/conversations?tab=primary`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    const primaryListAfterSend = (await primaryListAfterSendRes.json()) as {
      items: Array<{ public_id: string }>;
    };
    expect(primaryListAfterSend.items.some((c) => c.public_id === convPublicId)).toBe(true);

    // Khi Bob mở web đăng ký thiết bị mới -> nhận bootstrapKeyPair, nạp extractable: false và giải mã được tin nhắn cũ!
    const bobPrimaryDevice = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);
    const bobRegRes = await e2eeDevicesPost(
      new Request(`${origin}/api/v1/e2ee/devices`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          identityPublicKeyJwk: bobPrimaryDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: bobPrimaryDevice.signingPublicKeyJwk,
          keyFingerprint: bobPrimaryDevice.keyFingerprint,
        }),
      }),
    );
    expect(bobRegRes.status).toBe(200);
    const bobRegData = (await bobRegRes.json()) as {
      bootstrapKeyPair: Parameters<typeof importAndStoreBootstrapKeyMaterial>[1];
    };
    const importedBootstrap = await importAndStoreBootstrapKeyMaterial(
      bob.publicId,
      bobRegData.bootstrapKeyPair,
    );
    expect(importedBootstrap.identityPrivateKey.extractable).toBe(false);

    const bobMaterials = await listLocalDeviceKeyMaterials(bob.publicId);
    const decryptedOfflineMsg = await decryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alice.publicId,
      clientMsgId: 'msg_offline_bob_01',
      ciphertext: offlineMsgEnvelope.ciphertext,
      cryptoHeader: offlineMsgEnvelope.cryptoHeader,
      receiverKeyMaterials: bobMaterials,
    });
    expect(decryptedOfflineMsg.text).toBe('Tin nhắn gửi khi Bob chưa mở web lần nào');

    // 1. Khi hội thoại còn ở `pending`: Alice hỏi trạng thái hoạt động của Bob -> nhận `null`.
    const presWhilePendingRes = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [bob.publicId] }),
      }),
    );
    expect((await presWhilePendingRes.json()).presences[bob.publicId]).toBeNull();

    // 2. Bob bấm Chấp nhận (`accept`) -> cả hai ở `primary` -> Alice thấy trạng thái hoạt động của Bob ngay cả khi chưa follow nhau!
    const acceptRes = await acceptConversationPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/accept`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(acceptRes.status).toBe(200);

    const presAfterAcceptRes = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [bob.publicId] }),
      }),
    );
    expect((await presAfterAcceptRes.json()).presences[bob.publicId]).toEqual({
      isOnline: true,
      bucket: 'active_now',
      label: 'Đang hoạt động',
    });

    // 3. Bob chặn Alice -> đọc tin nhắn trả 404 Not Found.
    const blockRes = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    const msgAfterBlockRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(msgAfterBlockRes.status).toBe(404);
  });
});
