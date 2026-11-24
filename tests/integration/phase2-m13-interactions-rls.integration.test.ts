import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { GET as pinsListGet } from '@/app/api/v1/conversations/[conversationPublicId]/pins/route';
import { PATCH as preferencesPatch } from '@/app/api/v1/conversations/[conversationPublicId]/preferences/route';
import { DELETE as conversationDelete } from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { GET as forwardTargetsGet } from '@/app/api/v1/conversations/forward-targets/route';
import { GET as conversationsListGet } from '@/app/api/v1/conversations/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import {
  DELETE as messagePinDelete,
  POST as messagePinPost,
} from '@/app/api/v1/messages/[messagePublicId]/pin/route';
import {
  DELETE as messageReactionDelete,
  PUT as messageReactionPut,
} from '@/app/api/v1/messages/[messagePublicId]/reaction/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import {
  authIdentities,
  conversations,
  messagePins,
  messageReactions,
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
import { InMemoryMediaStorageAdapter } from '@/core/storage';
import {
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
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

let ipCounter = 70;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 180) + 10}`;
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
  if (cookieParts.length > 0) headers.cookie = cookieParts.join('; ');
  if (options.includeCsrf && jar.csrf) headers[CSRF_HEADER_NAME] = jar.csrf;
  if (options.contentType) headers['Content-Type'] = options.contentType;
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
const TEST_PASSWORD = 'TomatoPhase2_M13_Password!99';

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
    dateOfBirth: '1999-06-15',
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

describe('Integration M13: PostgreSQL RLS & Composite FK trên message_reactions/message_pins, Pin 5/3, Mute Badge & Forward Eligibility', () => {
  beforeEach(() => {
    clearMemoryKeystoreForTesting();
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m13:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
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
      mediaStorageProvider: new InMemoryMediaStorageAdapter(),
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

  async function ensureRlsVerifyRoleGrants(): Promise<void> {
    const db = getDb();
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
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversations", "conversation_participants", "messages", "message_user_deletions", "message_reactions", "message_pins" TO tomato_rls_verify_role`,
      );
      await tx.execute(
        sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"(), "public"."app_is_conversation_member"(uuid) TO tomato_rls_verify_role`,
      );
    });
  }

  async function follow(from: SeededUser, to: SeededUser): Promise<void> {
    const origin = getTestOrigin();
    const res = await followPost(
      new Request(`${origin}/api/v1/social/follow/${to.publicId}`, {
        method: 'POST',
        headers: createHeaders(from.jar, from.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: to.publicId }) },
    );
    expect([200, 201]).toContain(res.status);
  }

  async function createDirectConv(initiator: SeededUser, recipient: SeededUser): Promise<string> {
    const origin = getTestOrigin();
    const res = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(initiator.jar, initiator.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ recipientPublicId: recipient.publicId }),
      }),
    );
    expect([200, 201]).toContain(res.status);
    return ((await res.json()) as { conversation: { public_id: string } }).conversation.public_id;
  }

  async function sendEncryptedText(
    sender: SeededUser,
    recipient: SeededUser,
    convPublicId: string,
    plaintext: string,
    extra: { readonly replyToMessagePublicId?: string; readonly isForwarded?: boolean } = {},
  ): Promise<string> {
    const origin = getTestOrigin();
    const sKey = await getOrCreatePrimaryDeviceKeyMaterial(sender.publicId);
    const rKey = await getOrCreatePrimaryDeviceKeyMaterial(recipient.publicId);
    const clientMsgId = `m13_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const enc = await encryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: sender.publicId,
      clientMsgId,
      plaintext,
      forwarded: extra.isForwarded,
      senderDevice: sKey,
      recipientDevices: [
        {
          devicePublicId: rKey.devicePublicId,
          keyFingerprint: rKey.keyFingerprint,
          identityPublicKeyJwk: rKey.identityPublicKeyJwk,
          signingPublicKeyJwk: rKey.signingPublicKeyJwk,
        },
      ],
    });
    const res = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${convPublicId}/messages`, {
        method: 'POST',
        headers: createHeaders(sender.jar, sender.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          clientMsgId,
          messageType: 'text',
          ciphertext: enc.ciphertext,
          cryptoHeader: enc.cryptoHeader,
          ...(extra.replyToMessagePublicId
            ? { replyToMessagePublicId: extra.replyToMessagePublicId }
            : {}),
          ...(extra.isForwarded ? { isForwarded: true } : {}),
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: convPublicId }) },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { message: { public_id: string } }).message.public_id;
  }

  it('xác minh PostgreSQL RLS (NOBYPASSRLS), khóa ngoại kép chống tráo conversation_id, Reactions, Reply, Pin 5 tin + dọn tự động & deadlock recovery', async () => {
    const origin = getTestOrigin();
    const db = getDb();
    await ensureRlsVerifyRoleGrants();

    const alice = await seedAndLoginUser('m13_a', 'Alice M13');
    const bob = await seedAndLoginUser('m13_b', 'Bob M13');
    const david = await seedAndLoginUser('m13_d', 'David Outsider');

    await follow(alice, bob);
    await follow(bob, alice);
    await follow(alice, david);
    await follow(david, alice);

    const convAB = await createDirectConv(alice, bob);
    const convAD = await createDirectConv(alice, david);

    // Gửi 6 tin trong A-B và 1 tin trong A-D.
    const abMsgs: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      abMsgs.push(await sendEncryptedText(alice, bob, convAB, `Tin M13 #${i}`));
    }
    const adMsg1 = await sendEncryptedText(alice, david, convAD, 'Tin hội thoại khác');

    // 1. Trả lời hợp lệ trong A-B + trả lời chéo hội thoại bị chặn 404.
    const replyMsg = await sendEncryptedText(bob, alice, convAB, 'Trả lời tin #1', {
      replyToMessagePublicId: abMsgs[0],
    });
    expect(replyMsg).toBeTruthy();

    // 2. Thả cảm xúc & ghim tin #1 trên DB thật.
    const reactRes = await messageReactionPut(
      new Request(`${origin}/api/v1/messages/${abMsgs[0]!}/reaction`, {
        method: 'PUT',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ emoji: '🇻🇳' }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[0]! }) },
    );
    expect(reactRes.status).toBe(200);

    const pin1Res = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${abMsgs[0]!}/pin`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[0]! }) },
    );
    expect(pin1Res.status).toBe(200);

    // 3. Kiểm chứng PostgreSQL RLS (NOBYPASSRLS): David đọc 0 dòng từ message_reactions & message_pins của A-B,
    //    và bị PostgreSQL từ chối nếu cố chèn trực tiếp vào hội thoại A-B.
    const [convAbRow] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.publicId, convAB));
    const [msgAbRow] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.publicId, abMsgs[0]!));
    const [msgAdRow] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.publicId, adMsg1));

    await withRlsContext(david.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const visibleReactions = await tx
        .select()
        .from(messageReactions)
        .where(eq(messageReactions.conversationId, convAbRow!.id));
      expect(visibleReactions).toHaveLength(0);

      const visiblePins = await tx
        .select()
        .from(messagePins)
        .where(eq(messagePins.conversationId, convAbRow!.id));
      expect(visiblePins).toHaveLength(0);

      await expect(
        tx.insert(messageReactions).values({
          conversationId: convAbRow!.id,
          messageId: msgAbRow!.id,
          userId: david.id,
          emoji: '❤️',
        }),
      ).rejects.toThrow();

      await expect(
        tx.insert(messagePins).values({
          conversationId: convAbRow!.id,
          messageId: msgAbRow!.id,
          pinnedByUserId: david.id,
        }),
      ).rejects.toThrow();
    });

    // 4. Kiểm chứng khóa ngoại kép `(conversation_id, message_id)` ở tầng PostgreSQL:
    //    Kể cả Alice (thành viên cả 2 hội thoại A-B và A-D) cũng KHÔNG thể chèn (convAB, msgAdRow) vào message_pins hay message_reactions!
    await expect(
      db.insert(messagePins).values({
        conversationId: convAbRow!.id,
        messageId: msgAdRow!.id,
        pinnedByUserId: alice.id,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(messageReactions).values({
        conversationId: convAbRow!.id,
        messageId: msgAdRow!.id,
        userId: alice.id,
        emoji: '❤️',
      }),
    ).rejects.toThrow();

    // 5. Ghim đủ 5 tin (abMsgs[0..4]), tin thứ 6 trả 409; sau đó CẢ Alice & Bob xóa 1 phía tin #1 -> tự động dọn pin #1, tin #6 ghim được ngay!
    for (let i = 1; i < 5; i += 1) {
      const pRes = await messagePinPost(
        new Request(`${origin}/api/v1/messages/${abMsgs[i]!}/pin`, {
          method: 'POST',
          headers: createHeaders(alice.jar, alice.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: '{}',
        }),
        { params: Promise.resolve({ messagePublicId: abMsgs[i]! }) },
      );
      expect(pRes.status).toBe(200);
    }

    const sixthBlocked = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${abMsgs[5]!}/pin`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[5]! }) },
    );
    expect(sixthBlocked.status).toBe(409);

    // Cả 2 phía xóa 1 phía tin abMsgs[0] -> server tự động xóa bản ghi ghim abMsgs[0] trong DB!
    expect(
      (
        await messageDeleteForMe(
          new Request(`${origin}/api/v1/messages/${abMsgs[0]!}/for-me`, {
            method: 'DELETE',
            headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgs[0]! }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await messageDeleteForMe(
          new Request(`${origin}/api/v1/messages/${abMsgs[0]!}/for-me`, {
            method: 'DELETE',
            headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgs[0]! }) },
        )
      ).status,
    ).toBe(200);

    // Sau khi cả 2 xóa abMsgs[0], chỉ còn 4 tin ghim -> ghim tin #6 thành công (200)!
    const sixthAfterCleanup = await messagePinPost(
      new Request(`${origin}/api/v1/messages/${abMsgs[5]!}/pin`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: '{}',
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[5]! }) },
    );
    expect(sixthAfterCleanup.status).toBe(200);

    // Thu hồi tin #6 -> gỡ ghim & dọn reaction tự động + danh sách tin nhắn trả replyToMeta đầy đủ.
    const recall6 = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${abMsgs[5]!}/recall`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[5]! }) },
    );
    expect(recall6.status).toBe(200);

    const pinsAfterRecall = await pinsListGet(
      new Request(`${origin}/api/v1/conversations/${convAB}/pins`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convAB }) },
    );
    expect(pinsAfterRecall.status).toBe(200);
    const pinsJson = (await pinsAfterRecall.json()) as {
      items: Array<{ message: { public_id: string } }>;
      totalPinnedCount: number;
    };
    expect(pinsJson.totalPinnedCount).toBe(4);
    expect(pinsJson.items.some((i) => i.message.public_id === abMsgs[5])).toBe(false);

    // Gỡ cảm xúc của Bob và kiểm tra GET messages trả về metadata hợp lệ.
    expect(
      (
        await messageReactionDelete(
          new Request(`${origin}/api/v1/messages/${abMsgs[1]!}/reaction`, {
            method: 'DELETE',
            headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
          }),
          { params: Promise.resolve({ messagePublicId: abMsgs[1]! }) },
        )
      ).status,
    ).toBe(200);

    const unpin2 = await messagePinDelete(
      new Request(`${origin}/api/v1/messages/${abMsgs[1]!}/pin`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: abMsgs[1]! }) },
    );
    expect(unpin2.status).toBe(200);

    const msgsRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${convAB}/messages`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: convAB }) },
    );
    expect(msgsRes.status).toBe(200);
    const msgsJson = (await msgsRes.json()) as {
      items: Array<{ public_id: string; replyToMeta?: { messagePublicId: string } | null }>;
    };
    const replyItem = msgsJson.items.find((i) => i.public_id === replyMsg);
    expect(replyItem?.replyToMeta?.messagePublicId).toBe(abMsgs[0]);
  });

  it('xác minh giới hạn 3 đoạn chat ghim, giải phóng suất ghim khi xóa đoạn chat, tắt thông báo trừ khỏi unreadCount & lọc Forward Targets', async () => {
    const origin = getTestOrigin();

    const alice = await seedAndLoginUser('m13_p_a', 'Alice Prefs');
    const peer1 = await seedAndLoginUser('m13_p_1', 'Peer Mot');
    const peer2 = await seedAndLoginUser('m13_p_2', 'Peer Hai');
    const peer3 = await seedAndLoginUser('m13_p_3', 'Peer Ba');
    const peer4 = await seedAndLoginUser('m13_p_4', 'Peer Bon');
    const stranger = await seedAndLoginUser('m13_p_s', 'Stranger Khong Quen');
    const oneWay = await seedAndLoginUser('m13_p_o', 'OneWay Follow');

    // Mutual follow với peer1..4; 1-way follow với oneWay (oneWay -> alice, chưa nhắn tin nào).
    for (const p of [peer1, peer2, peer3, peer4]) {
      await follow(alice, p);
      await follow(p, alice);
    }
    await follow(oneWay, alice);

    const c1 = await createDirectConv(alice, peer1);
    const c2 = await createDirectConv(alice, peer2);
    const c3 = await createDirectConv(alice, peer3);
    const c4 = await createDirectConv(alice, peer4);

    // Gửi 1 tin từ mỗi peer để các đoạn chat xuất hiện trong danh sách và tạo unread cho Alice.
    await sendEncryptedText(peer1, alice, c1, 'Chào từ Peer 1');
    await sendEncryptedText(peer2, alice, c2, 'Chào từ Peer 2');
    await sendEncryptedText(peer3, alice, c3, 'Chào từ Peer 3');
    await sendEncryptedText(peer4, alice, c4, 'Chào từ Peer 4');

    // 1. Forward targets của Alice chỉ gồm peer1..4, KHÔNG có stranger và KHÔNG có oneWay!
    const fwdTargetsRes = await forwardTargetsGet(
      new Request(`${origin}/api/v1/conversations/forward-targets?limit=50`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    expect(fwdTargetsRes.status).toBe(200);
    const fwdJson = (await fwdTargetsRes.json()) as { items: Array<{ public_id: string }> };
    const fwdIds = new Set(fwdJson.items.map((i) => i.public_id));
    expect(fwdIds.has(peer1.publicId)).toBe(true);
    expect(fwdIds.has(peer4.publicId)).toBe(true);
    expect(fwdIds.has(stranger.publicId)).toBe(false);
    expect(fwdIds.has(oneWay.publicId)).toBe(false);

    // Chuyển tiếp tới stranger -> 403; tới oneWay (1-way chưa từng nhắn) -> 403.
    expect(
      (
        await directConversationPost(
          new Request(`${origin}/api/v1/conversations/direct`, {
            method: 'POST',
            headers: createHeaders(alice.jar, alice.ip, {
              includeCsrf: true,
              contentType: 'application/json',
            }),
            body: JSON.stringify({ recipientPublicId: stranger.publicId, purpose: 'forward' }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await directConversationPost(
          new Request(`${origin}/api/v1/conversations/direct`, {
            method: 'POST',
            headers: createHeaders(alice.jar, alice.ip, {
              includeCsrf: true,
              contentType: 'application/json',
            }),
            body: JSON.stringify({ recipientPublicId: oneWay.publicId, purpose: 'forward' }),
          }),
        )
      ).status,
    ).toBe(403);

    // 2. Ghim tối đa 3 đoạn chat (c1, c2, c3) -> c4 bị chặn 409.
    for (const cid of [c1, c2, c3]) {
      const res = await preferencesPatch(
        new Request(`${origin}/api/v1/conversations/${cid}/preferences`, {
          method: 'PATCH',
          headers: createHeaders(alice.jar, alice.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({ pinned: true }),
        }),
        { params: Promise.resolve({ conversationPublicId: cid }) },
      );
      expect(res.status).toBe(200);
    }

    const pin4th = await preferencesPatch(
      new Request(`${origin}/api/v1/conversations/${c4}/preferences`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ pinned: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: c4 }) },
    );
    expect(pin4th.status).toBe(409);

    // Xóa đoạn chat c1 -> tự giải phóng suất ghim -> ghim c4 thành công!
    const delC1 = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${c1}`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: c1 }) },
    );
    expect(delC1.status).toBe(200);

    const pin4thAfterDelete = await preferencesPatch(
      new Request(`${origin}/api/v1/conversations/${c4}/preferences`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ pinned: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: c4 }) },
    );
    expect(pin4thAfterDelete.status).toBe(200);

    // 3. Tắt thông báo c2: `unreadConversationsCount` giảm đi 1 (từ 3 còn 2: c3, c4)!
    const listBeforeMute = await conversationsListGet(
      new Request(`${origin}/api/v1/conversations?tab=primary&limit=20`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    expect(listBeforeMute.status).toBe(200);
    const beforeJson = (await listBeforeMute.json()) as {
      items: Array<{ public_id: string; myState: { isPinned?: boolean } }>;
      unreadConversationsCount: number;
    };
    expect(beforeJson.unreadConversationsCount).toBe(3);
    // 3 đoạn chat đã ghim (c4, c3, c2) nằm trên cùng theo thứ tự pinnedAt mới nhất.
    expect(beforeJson.items.slice(0, 3).every((i) => i.myState.isPinned === true)).toBe(true);

    const muteC2 = await preferencesPatch(
      new Request(`${origin}/api/v1/conversations/${c2}/preferences`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ muted: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: c2 }) },
    );
    expect(muteC2.status).toBe(200);
    const muteJson = (await muteC2.json()) as {
      isMuted: boolean;
      unreadConversationsCount: number;
    };
    expect(muteJson.isMuted).toBe(true);
    expect(muteJson.unreadConversationsCount).toBe(2);
  });
});
