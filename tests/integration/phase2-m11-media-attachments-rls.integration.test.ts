import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as uploadTokenPost } from '@/app/api/v1/conversations/[conversationPublicId]/attachments/upload-token/route';
import { POST as messagesPost } from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { DELETE as conversationDelete } from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { POST as e2eeDevicesPost } from '@/app/api/v1/e2ee/devices/route';
import { PUT as localChatMediaPut } from '@/app/api/v1/media/local/chat/[attachmentPublicId]/route';
import { GET as messageAttachmentGet } from '@/app/api/v1/messages/[messagePublicId]/attachment/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import {
  authIdentities,
  conversations,
  messageAttachments,
  messages,
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
import { InMemoryMediaStorageAdapter, generateChatMediaStorageKey } from '@/core/storage';
import {
  clearMemoryKeystoreForTesting,
  decryptDirectMessage,
  decryptMediaBinary,
  encryptDirectMessage,
  encryptMediaBinary,
  getOrCreatePrimaryDeviceKeyMaterial,
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
  type ChatMessageDto,
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

let ipCounter = 180;
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
  options: { includeCsrf?: boolean; contentType?: string } = {},
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
  if (options.contentType) {
    headers['Content-Type'] = options.contentType;
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
const TEST_PASSWORD = 'TomatoPhase2_M11_Password!99';

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

describe('Integration M11: PostgreSQL RLS `message_attachments` (Non-BYPASSRLS), Upload-Token -> Bind Nguyên tử, Dọn rác Lười, Thu hồi xóa Storage & Xóa 1 phía/Hội thoại', () => {
  let memoryStorage: InMemoryMediaStorageAdapter;

  beforeEach(() => {
    clearMemoryKeystoreForTesting();
    memoryStorage = new InMemoryMediaStorageAdapter();
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m11:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
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
      mediaStorageProvider: memoryStorage,
      auditLogService,
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

  it('kiểm chứng toàn vòng đời ảnh HD & tin nhắn thoại E2EE + PostgreSQL RLS + Lazy Orphan GC + Recall xóa Storage + Delete-for-me/Conversation', async () => {
    const origin = getTestOrigin();
    const db = getDb();

    const alice = await seedAndLoginUser('m11_a', 'Alice M11');
    const bob = await seedAndLoginUser('m11_b', 'Bob M11');
    const david = await seedAndLoginUser('m11_d', 'David M11');

    // Cấp quyền cho role kiểm thử RLS không BYPASSRLS trên bảng `message_attachments` (tuần tự hóa bằng advisory lock).
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
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversations", "conversation_participants", "messages", "message_user_deletions", "message_attachments" TO tomato_rls_verify_role`,
      );
      await tx.execute(
        sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"(), "public"."app_is_conversation_member"(uuid) TO tomato_rls_verify_role`,
      );
    });

    // Bob follow Alice để hội thoại A-B vào thẳng `primary` (cho phép gửi ảnh/thoại).
    const followRes = await followPost(
      new Request(`${origin}/api/v1/social/follow/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    expect([200, 201]).toContain(followRes.status);

    // Đăng ký thiết bị E2EE cho Alice & Bob.
    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);
    for (const [u, mat] of [
      [alice, aliceMat],
      [bob, bobMat],
    ] as const) {
      const regRes = await e2eeDevicesPost(
        new Request(`${origin}/api/v1/e2ee/devices`, {
          method: 'POST',
          headers: createHeaders(u.jar, u.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({
            identityPublicKeyJwk: mat.identityPublicKeyJwk,
            signingPublicKeyJwk: mat.signingPublicKeyJwk,
            keyFingerprint: mat.keyFingerprint,
          }),
        }),
      );
      expect(regRes.status).toBe(200);
    }

    // Tạo hội thoại A-B.
    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ recipientPublicId: bob.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    const convId = ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;

    // 1. Kiểm thử Dọn rác Lười (Lazy Orphan Cleanup):
    //    Cấy 1 bản ghi đính kèm mồ côi đã quá hạn > 60 phút trong DB & InMemoryStorage.
    const [convRow] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.publicId, convId));
    const convInternalId = convRow!.id;
    const orphanStorageKey = generateChatMediaStorageKey();
    await memoryStorage.putObject({
      storageKey: orphanStorageKey,
      body: Buffer.from('stale-orphan-ciphertext'),
      contentType: 'application/octet-stream',
    });
    const orphanId = generateUuidV7();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(messageAttachments).values({
      id: orphanId,
      publicId: generatePublicId(),
      conversationId: convInternalId,
      uploaderId: alice.id,
      messageId: null,
      mediaKind: 'image',
      storageKey: orphanStorageKey,
      storageUrl: `/api/v1/media/local/chat/${orphanId}`,
      ciphertextSizeBytes: 23,
      ciphertextSha256: 'e'.repeat(64),
      deletedAt: null,
      createdAt: twoHoursAgo,
    });
    expect(memoryStorage.has(orphanStorageKey)).toBe(true);

    // Helper tải & gửi tin nhắn media E2EE.
    async function sendEncryptedMedia(params: {
      readonly sender: SeededUser;
      readonly senderMat: typeof aliceMat;
      readonly recipientMat: typeof bobMat;
      readonly clientMsgId: string;
      readonly mediaKind: 'image' | 'voice';
      readonly plainBytes: Uint8Array;
      readonly mimeType: string;
    }) {
      const encBin = await encryptMediaBinary({
        plainBytes: params.plainBytes,
        conversationPublicId: convId,
        senderPublicId: params.sender.publicId,
        clientMsgId: params.clientMsgId,
        mediaKind: params.mediaKind,
      });

      const tokRes = await uploadTokenPost(
        new Request(`${origin}/api/v1/conversations/${convId}/attachments/upload-token`, {
          method: 'POST',
          headers: createHeaders(params.sender.jar, params.sender.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({
            mediaKind: params.mediaKind,
            ciphertextSizeBytes: encBin.ciphertextSizeBytes,
            ciphertextSha256: encBin.ciphertextSha256,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      );
      expect(tokRes.status).toBe(201);
      const grant = (await tokRes.json()) as {
        attachmentPublicId: string;
        pathname: string;
        uploadUrl: string;
      };

      // Gửi lệch byte phải bị chặn (400 SHA-256 mismatch).
      const tamperedBytes = new Uint8Array(encBin.ciphertextBytes);
      tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
      const badPutRes = await localChatMediaPut(
        new Request(`${origin}${grant.uploadUrl}`, {
          method: 'PUT',
          headers: createHeaders(params.sender.jar, params.sender.ip, {
            includeCsrf: true,
            contentType: 'application/octet-stream',
          }),
          body: new Blob([tamperedBytes], { type: 'application/octet-stream' }),
        }),
        { params: Promise.resolve({ attachmentPublicId: grant.attachmentPublicId }) },
      );
      expect(badPutRes.status).toBe(400);

      // Gửi đúng bản mã -> 200.
      const okPutRes = await localChatMediaPut(
        new Request(`${origin}${grant.uploadUrl}`, {
          method: 'PUT',
          headers: createHeaders(params.sender.jar, params.sender.ip, {
            includeCsrf: true,
            contentType: 'application/octet-stream',
          }),
          body: new Blob([encBin.ciphertextBytes], { type: 'application/octet-stream' }),
        }),
        { params: Promise.resolve({ attachmentPublicId: grant.attachmentPublicId }) },
      );
      expect(okPutRes.status).toBe(200);

      const envelope = await encryptDirectMessage({
        conversationPublicId: convId,
        senderPublicId: params.sender.publicId,
        clientMsgId: params.clientMsgId,
        plaintext: '',
        media: {
          kind: params.mediaKind,
          attachmentPublicId: grant.attachmentPublicId,
          fileKey: encBin.fileKey,
          fileIv: encBin.fileIv,
          ciphertextSha256: encBin.ciphertextSha256,
          mimeType: params.mimeType,
          sizeBytes: params.plainBytes.byteLength,
          ...(params.mediaKind === 'image' ? { width: 800, height: 600 } : { durationMs: 3200 }),
        },
        senderDevice: params.senderMat,
        recipientDevices: [
          {
            devicePublicId: params.recipientMat.devicePublicId,
            keyFingerprint: params.recipientMat.keyFingerprint,
            identityPublicKeyJwk: params.recipientMat.identityPublicKeyJwk,
            signingPublicKeyJwk: params.recipientMat.signingPublicKeyJwk,
          },
        ],
      });

      const msgRes = await messagesPost(
        new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
          method: 'POST',
          headers: createHeaders(params.sender.jar, params.sender.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({
            clientMsgId: params.clientMsgId,
            messageType: params.mediaKind,
            attachmentPublicId: grant.attachmentPublicId,
            ciphertext: envelope.ciphertext,
            cryptoHeader: envelope.cryptoHeader,
          }),
        }),
        { params: Promise.resolve({ conversationPublicId: convId }) },
      );
      expect(msgRes.status).toBe(201);
      const body = (await msgRes.json()) as { message: ChatMessageDto };
      return { message: body.message, grant, encBin };
    }

    // 2. Alice gửi Ảnh #1 -> kích hoạt Lazy Orphan GC dọn sạch orphan cũ!
    const photo1Bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 11, 22, 33, 44, 55, 66, 77, 88]);
    const sentImg1 = await sendEncryptedMedia({
      sender: alice,
      senderMat: aliceMat,
      recipientMat: bobMat,
      clientMsgId: 'pg_m11_img_1',
      mediaKind: 'image',
      plainBytes: photo1Bytes,
      mimeType: 'image/png',
    });

    // Kiểm tra bản ghi mồ côi đã được đánh dấu xóa trong DB và xóa khỏi Storage!
    const [orphanAfter] = await db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, orphanId));
    expect(orphanAfter?.deletedAt).not.toBeNull();
    expect(memoryStorage.has(orphanStorageKey)).toBe(false);
    expect(memoryStorage.deletedKeys).toContain(orphanStorageKey);

    // 3. Chống tái sử dụng cùng 1 `attachmentPublicId` cho tin thứ hai -> 409 CONFLICT.
    const dupEnvelope = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: 'pg_m11_reuse_attempt',
      plaintext: '',
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
    const reuseRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          clientMsgId: 'pg_m11_reuse_attempt',
          messageType: 'image',
          attachmentPublicId: sentImg1.grant.attachmentPublicId,
          ciphertext: dupEnvelope.ciphertext,
          cryptoHeader: dupEnvelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(reuseRes.status).toBe(409);

    // 4. Kiểm chứng PostgreSQL RLS trên bảng `message_attachments` dưới role NOBYPASSRLS:
    //    - Người ngoài (David) đọc 0 dòng và bị từ chối khi chèn vào hội thoại A-B.
    //    - Thành viên (Bob) đọc thấy đúng dòng đính kèm.
    const davidSeenCount = await withRlsContext(david.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const rows = await tx
        .select()
        .from(messageAttachments)
        .where(eq(messageAttachments.publicId, sentImg1.grant.attachmentPublicId));
      return rows.length;
    });
    expect(davidSeenCount).toBe(0);

    await expect(
      withRlsContext(david.id, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
        await tx.insert(messageAttachments).values({
          id: generateUuidV7(),
          publicId: generatePublicId(),
          conversationId: convInternalId,
          uploaderId: david.id,
          messageId: null,
          mediaKind: 'image',
          storageKey: generateChatMediaStorageKey(),
          ciphertextSizeBytes: 64,
          ciphertextSha256: 'f'.repeat(64),
          createdAt: new Date(),
        });
      }),
    ).rejects.toThrow();

    const bobSeenCount = await withRlsContext(bob.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const rows = await tx
        .select()
        .from(messageAttachments)
        .where(eq(messageAttachments.publicId, sentImg1.grant.attachmentPublicId));
      return rows.length;
    });
    expect(bobSeenCount).toBe(1);

    // 5. Bob tải & giải mã Ảnh #1 byte-for-byte chính xác!
    const decryptedEnv = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: sentImg1.message.clientMsgId,
      ciphertext: sentImg1.message.ciphertext!,
      cryptoHeader: sentImg1.message.cryptoHeader!,
      receiverKeyMaterials: [bobMat],
    });
    expect(decryptedEnv.media?.attachmentPublicId).toBe(sentImg1.grant.attachmentPublicId);

    const bobGrantRes = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${sentImg1.message.public_id}/attachment`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ messagePublicId: sentImg1.message.public_id }) },
    );
    expect(bobGrantRes.status).toBe(200);
    const bobGrant = (await bobGrantRes.json()) as {
      downloadUrl: string;
      ciphertextSha256: string;
    };
    expect(bobGrant.ciphertextSha256).toBe(decryptedEnv.media!.ciphertextSha256);

    const bobBinRes = await messageAttachmentGet(
      new Request(`${origin}${bobGrant.downloadUrl}`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ messagePublicId: sentImg1.message.public_id }) },
    );
    expect(bobBinRes.status).toBe(200);
    const bobCiphertextBytes = new Uint8Array(await bobBinRes.arrayBuffer());
    const bobPlainPhoto = await decryptMediaBinary({
      ciphertextBytes: bobCiphertextBytes,
      fileKey: decryptedEnv.media!.fileKey,
      fileIv: decryptedEnv.media!.fileIv,
      expectedSha256: decryptedEnv.media!.ciphertextSha256,
      conversationPublicId: convId,
      senderPublicId: alice.publicId,
      clientMsgId: sentImg1.message.clientMsgId,
      mediaKind: 'image',
    });
    expect(Array.from(bobPlainPhoto)).toEqual(Array.from(photo1Bytes));

    // 6. Thu hồi Ảnh #1 trong 5 phút -> xóa mềm `message_attachments`, xóa file vật lý trong Storage,
    //    xóa sạch `messages.attachment_storage_key = NULL`, và tải lại trả 404 cho cả hai!
    const recallImg1Res = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${sentImg1.message.public_id}/recall`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: sentImg1.message.public_id }) },
    );
    expect(recallImg1Res.status).toBe(200);
    expect(memoryStorage.has(sentImg1.grant.pathname)).toBe(false);

    const [recalledMsgRow] = await db
      .select()
      .from(messages)
      .where(eq(messages.publicId, sentImg1.message.public_id));
    expect(recalledMsgRow?.attachmentStorageKey).toBeNull();
    expect(recalledMsgRow?.recalledAt).not.toBeNull();

    const bobAfterRecallRes = await messageAttachmentGet(
      new Request(`${origin}/api/v1/messages/${sentImg1.message.public_id}/attachment`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ messagePublicId: sentImg1.message.public_id }) },
    );
    expect(bobAfterRecallRes.status).toBe(404);

    // 7. Alice gửi Ảnh #2 và Voice #3 -> kiểm chứng Xóa 1 phía & Xóa đoạn chat giữ nguyên quyền tải của Bob.
    const sentImg2 = await sendEncryptedMedia({
      sender: alice,
      senderMat: aliceMat,
      recipientMat: bobMat,
      clientMsgId: 'pg_m11_img_2',
      mediaKind: 'image',
      plainBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]),
      mimeType: 'image/jpeg',
    });
    const voice3Bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6, 5, 4, 3, 2]);
    const sentVoice3 = await sendEncryptedMedia({
      sender: alice,
      senderMat: aliceMat,
      recipientMat: bobMat,
      clientMsgId: 'pg_m11_voice_3',
      mediaKind: 'voice',
      plainBytes: voice3Bytes,
      mimeType: 'audio/webm;codecs=opus',
    });

    // Alice xóa 1 phía Ảnh #2 -> Alice nhận 404, Bob vẫn tải được 200!
    const aliceDelImg2 = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${sentImg2.message.public_id}/for-me`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: sentImg2.message.public_id }) },
    );
    expect(aliceDelImg2.status).toBe(200);

    const [aliceGetImg2, bobGetImg2] = await Promise.all([
      messageAttachmentGet(
        new Request(`${origin}/api/v1/messages/${sentImg2.message.public_id}/attachment`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
        { params: Promise.resolve({ messagePublicId: sentImg2.message.public_id }) },
      ),
      messageAttachmentGet(
        new Request(`${origin}/api/v1/messages/${sentImg2.message.public_id}/attachment`, {
          headers: createHeaders(bob.jar, bob.ip),
        }),
        { params: Promise.resolve({ messagePublicId: sentImg2.message.public_id }) },
      ),
    ]);
    expect(aliceGetImg2.status).toBe(404);
    expect(bobGetImg2.status).toBe(200);

    // Alice xóa cả đoạn chat -> Alice nhận 404 khi tải Voice #3 (`seq <= cleared_before_seq`), Bob vẫn tải & giải mã bình thường!
    const aliceDelConv = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: convId }) },
    );
    expect(aliceDelConv.status).toBe(200);

    const [aliceGetVoice3, bobGetVoice3] = await Promise.all([
      messageAttachmentGet(
        new Request(`${origin}/api/v1/messages/${sentVoice3.message.public_id}/attachment`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
        { params: Promise.resolve({ messagePublicId: sentVoice3.message.public_id }) },
      ),
      messageAttachmentGet(
        new Request(
          `${origin}/api/v1/messages/${sentVoice3.message.public_id}/attachment?download=1`,
          {
            headers: createHeaders(bob.jar, bob.ip),
          },
        ),
        { params: Promise.resolve({ messagePublicId: sentVoice3.message.public_id }) },
      ),
    ]);
    expect(aliceGetVoice3.status).toBe(404);
    expect(bobGetVoice3.status).toBe(200);
    expect((await bobGetVoice3.arrayBuffer()).byteLength).toBe(
      sentVoice3.encBin.ciphertextSizeBytes,
    );
  });
});
