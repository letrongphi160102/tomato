import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as callActionPost } from '@/app/api/v1/calls/[callPublicId]/action/route';
import { POST as callSignalPost } from '@/app/api/v1/calls/[callPublicId]/signal/route';
import { POST as iceServersPost } from '@/app/api/v1/calls/ice-servers/route';
import { POST as createCallPost } from '@/app/api/v1/calls/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '@/app/api/v1/conversations/[conversationPublicId]/messages/route';
import { DELETE as conversationDelete } from '@/app/api/v1/conversations/[conversationPublicId]/route';
import { POST as directConversationPost } from '@/app/api/v1/conversations/direct/route';
import { DELETE as messageDeleteForMe } from '@/app/api/v1/messages/[messagePublicId]/for-me/route';
import { POST as messageRecallPost } from '@/app/api/v1/messages/[messagePublicId]/recall/route';
import { PATCH as messageEditPatch } from '@/app/api/v1/messages/[messagePublicId]/route';
import { POST as blockPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { POST as followPost } from '@/app/api/v1/social/follow/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb, withRlsContext } from '@/core/db';
import { authIdentities, callSessions, messages, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
  type LocalRealtimeEventMessage,
} from '@/core/realtime';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import { InMemoryMediaStorageAdapter } from '@/core/storage';
import {
  clearMemoryKeystoreForTesting,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
} from '@/lib/e2ee';
import {
  StunFallbackTurnProvider,
  resetTurnCredentialProviderForTesting,
  setTurnCredentialProviderForTesting,
} from '@/core/webrtc';
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
  CallRepository,
  CallSignalingService,
  InMemoryCallDeclineCooldownStore,
  resetCallSignalingServiceForTesting,
  setCallSignalingServiceForTesting,
} from '@/modules/calls';
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

let ipCounter = 20;
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
const TEST_PASSWORD = 'TomatoPhase2_M12_Password!99';

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

describe('Integration M12: PostgreSQL RLS `call_sessions` (NOBYPASSRLS), Vòng đời WebRTC Signaling, Auto-Sweep 45s/120s, Busy, Decline Cooldown, Block cắt gọi & call_event', () => {
  let realtimeAdapter: InMemoryRealtimeAdapter;
  let declineCooldownStore: InMemoryCallDeclineCooldownStore;

  beforeEach(() => {
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m12:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
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

    realtimeAdapter = new InMemoryRealtimeAdapter({ isolated: true });
    declineCooldownStore = new InMemoryCallDeclineCooldownStore();

    const turnProvider = new StunFallbackTurnProvider();
    const callSignalingService = new CallSignalingService({
      repository: new CallRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
      turnCredentialProvider: turnProvider,
      declineCooldownStore,
    });

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
      callSignalingService,
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
    setTurnCredentialProviderForTesting(turnProvider);
    setCallSignalingServiceForTesting(callSignalingService);
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
      resetTurnCredentialProviderForTesting();
      resetCallSignalingServiceForTesting();
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
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "conversations", "conversation_participants", "messages", "message_user_deletions", "call_sessions" TO tomato_rls_verify_role`,
      );
      await tx.execute(
        sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"(), "public"."app_is_conversation_member"(uuid), "public"."app_user_has_active_call"(uuid), "public"."app_sweep_stale_calls_for_user"(uuid) TO tomato_rls_verify_role`,
      );
    });
  }

  async function createPrimaryDirectConv(
    initiator: SeededUser,
    recipient: SeededUser,
  ): Promise<string> {
    const origin = getTestOrigin();
    // Recipient follows Initiator để hội thoại vào thẳng trạng thái `primary`.
    const followRes = await followPost(
      new Request(`${origin}/api/v1/social/follow/${initiator.publicId}`, {
        method: 'POST',
        headers: createHeaders(recipient.jar, recipient.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: initiator.publicId }) },
    );
    expect([200, 201]).toContain(followRes.status);

    const convRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(initiator.jar, initiator.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ recipientPublicId: recipient.publicId }),
      }),
    );
    expect(convRes.status).toBe(201);
    return ((await convRes.json()) as { conversation: { public_id: string } }).conversation
      .public_id;
  }

  it('kiểm chứng PostgreSQL RLS (NOBYPASSRLS) trên call_sessions, vòng đời Signaling/Renegotiation/Heartbeat/End, call_event, Pending 403 & Busy 409', async () => {
    const origin = getTestOrigin();
    const db = getDb();
    await ensureRlsVerifyRoleGrants();

    const alice = await seedAndLoginUser('m12_a', 'Alice M12');
    const bob = await seedAndLoginUser('m12_b', 'Bob M12');
    const david = await seedAndLoginUser('m12_d', 'David M12');

    // 1. Lấy danh sách ICE servers: Cache-Control: no-store, tuyệt đối không lộ khóa bí mật.
    const iceRes = await iceServersPost(
      new Request(`${origin}/api/v1/calls/ice-servers`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: '{}',
      }),
    );
    expect(iceRes.status).toBe(200);
    expect(iceRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const iceBody = (await iceRes.json()) as {
      iceServers: Array<{ urls: string | string[] }>;
      ttlSeconds: number;
    };
    expect(iceBody.iceServers.length).toBeGreaterThan(0);
    expect(iceBody.ttlSeconds).toBeLessThanOrEqual(900);
    const iceSerialized = JSON.stringify(iceBody);
    expect(iceSerialized).not.toContain('secretKey');
    expect(iceSerialized).not.toContain('apiKey');

    // 2. Hội thoại đang chờ (pending): Alice chưa được David follow -> gọi bị chặn cứng 403 CHAT_PENDING_TEXT_ONLY.
    const pendingConvRes = await directConversationPost(
      new Request(`${origin}/api/v1/conversations/direct`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ recipientPublicId: david.publicId }),
      }),
    );
    expect(pendingConvRes.status).toBe(201);
    const pendingConvId = ((await pendingConvRes.json()) as { conversation: { public_id: string } })
      .conversation.public_id;

    const pendingCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: pendingConvId, callType: 'audio' }),
      }),
    );
    expect(pendingCallRes.status).toBe(403);
    expect(((await pendingCallRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_PENDING_TEXT_ONLY',
    );

    // 3. Tạo hội thoại primary giữa Alice <-> Bob và David <-> Bob.
    const abConvId = await createPrimaryDirectConv(alice, bob);
    const dbConvId = await createPrimaryDirectConv(david, bob);

    const aliceEvents: LocalRealtimeEventMessage[] = [];
    const bobEvents: LocalRealtimeEventMessage[] = [];
    const unsubA = realtimeAdapter.subscribeLocal(alice.publicId, (e) => aliceEvents.push(e));
    const unsubB = realtimeAdapter.subscribeLocal(bob.publicId, (e) => bobEvents.push(e));

    // 4. Alice khởi tạo cuộc gọi thoại tới Bob.
    const createRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: abConvId, callType: 'audio' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdJson = (await createRes.json()) as {
      call: { public_id: string; status: string; callType: string };
    };
    const callPublicId = createdJson.call.public_id;
    expect(createdJson.call.status).toBe('ringing');
    expect(JSON.stringify(createdJson)).not.toContain(alice.id);
    expect(JSON.stringify(createdJson)).not.toContain(bob.id);
    expect(bobEvents.some((e) => e.event === 'call.incoming')).toBe(true);

    // 5. Xác minh PostgreSQL RLS thật bằng role NOBYPASSRLS (`tomato_rls_verify_role`).
    await withRlsContext(david.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const visibleToDavid = await tx
        .select({ publicId: callSessions.publicId })
        .from(callSessions)
        .where(eq(callSessions.publicId, callPublicId));
      expect(visibleToDavid).toHaveLength(0);

      // Hàm `app_user_has_active_call` trả true chính xác cho Bob mà không lộ row.
      const busyCheck = await tx.execute(
        sql`SELECT "public"."app_user_has_active_call"(${bob.id}::uuid) AS active`,
      );
      expect((busyCheck.rows[0] as { active: boolean }).active).toBe(true);
    });

    // David cố tình chèn giả mạo dòng call_sessions với callerId = alice.id -> bị PostgreSQL RLS chặn (`42501`).
    const [rowForIds] = await db
      .select({ conversationId: callSessions.conversationId })
      .from(callSessions)
      .where(eq(callSessions.publicId, callPublicId));

    await expect(
      withRlsContext(david.id, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
        await tx.insert(callSessions).values({
          id: generateUuidV7(),
          publicId: generatePublicId(),
          conversationId: rowForIds!.conversationId,
          callerId: alice.id,
          calleeId: bob.id,
          callType: 'audio',
          status: 'ringing',
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
        });
      }),
    ).rejects.toThrow();

    await withRlsContext(bob.id, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      const visibleToBob = await tx
        .select({ publicId: callSessions.publicId })
        .from(callSessions)
        .where(eq(callSessions.publicId, callPublicId));
      expect(visibleToBob).toHaveLength(1);
    });

    // 6. Kiểm tra trạng thái BẬN (`409 CALL_BUSY`): David gọi Bob khi Bob đang đổ chuông từ Alice -> 409 + call_event 'busy'.
    const busyCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(david.jar, david.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: dbConvId, callType: 'video' }),
      }),
    );
    expect(busyCallRes.status).toBe(409);
    expect(((await busyCallRes.json()) as { error: { code: string } }).error.code).toBe(
      'CALL_BUSY',
    );

    const dbConvMessagesRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${dbConvId}/messages`, {
        headers: createHeaders(david.jar, david.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: dbConvId }) },
    );
    expect(dbConvMessagesRes.status).toBe(200);
    const dbConvMessages = ((await dbConvMessagesRes.json()) as { items: ChatMessageDto[] }).items;
    expect(
      dbConvMessages.some(
        (m) => m.messageType === 'call_event' && m.callEventMeta?.status === 'busy',
      ),
    ).toBe(true);

    // 7. Bob chấp nhận cuộc gọi (`accept`) -> trạng thái `connected`.
    const acceptRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${callPublicId}/action`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'accept' }),
      }),
      { params: Promise.resolve({ callPublicId }) },
    );
    expect(acceptRes.status).toBe(200);
    expect(((await acceptRes.json()) as { call: { status: string } }).call.status).toBe(
      'connected',
    );
    expect(aliceEvents.some((e) => e.event === 'call.accepted')).toBe(true);

    // 8. Signaling (offer, answer, ice-candidate) & Renegotiation SDP ~30KB khi đang `connected`.
    const largeSdp = `v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n${'a=fmtp:96 synthetic-codec-line\r\n'.repeat(900)}`;
    expect(largeSdp.length).toBeGreaterThan(20_000);
    expect(largeSdp.length).toBeLessThan(32_768);

    const offerSignalRes = await callSignalPost(
      new Request(`${origin}/api/v1/calls/${callPublicId}/signal`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          type: 'offer',
          sdp: largeSdp,
        }),
      }),
      { params: Promise.resolve({ callPublicId }) },
    );
    expect(offerSignalRes.status).toBe(200);
    expect(bobEvents.some((e) => e.event === 'call.signal')).toBe(true);

    // David (người ngoài cuộc) cố bơm signal -> 404 đồng nhất.
    const davidSignalRes = await callSignalPost(
      new Request(`${origin}/api/v1/calls/${callPublicId}/signal`, {
        method: 'POST',
        headers: createHeaders(david.jar, david.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          type: 'ice-candidate',
          candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        }),
      }),
      { params: Promise.resolve({ callPublicId }) },
    );
    expect(davidSignalRes.status).toBe(404);

    // 9. Heartbeat cập nhật `last_heartbeat_at`.
    const [beforeHb] = await db
      .select({ lastHeartbeatAt: callSessions.lastHeartbeatAt })
      .from(callSessions)
      .where(eq(callSessions.publicId, callPublicId));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const hbRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${callPublicId}/action`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'heartbeat' }),
      }),
      { params: Promise.resolve({ callPublicId }) },
    );
    expect(hbRes.status).toBe(200);

    const [afterHb] = await db
      .select({ lastHeartbeatAt: callSessions.lastHeartbeatAt })
      .from(callSessions)
      .where(eq(callSessions.publicId, callPublicId));
    expect(afterHb!.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
      beforeHb!.lastHeartbeatAt.getTime(),
    );

    // 10. Kết thúc cuộc gọi (`end`) -> tạo bản ghi `call_event` trong `messages` (`ciphertext = NULL`).
    const endRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${callPublicId}/action`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'end' }),
      }),
      { params: Promise.resolve({ callPublicId }) },
    );
    expect(endRes.status).toBe(200);
    const endJson = (await endRes.json()) as {
      call: { status: string; durationSeconds: number | null };
    };
    expect(endJson.call.status).toBe('ended');
    expect(endJson.call.durationSeconds).toBeGreaterThanOrEqual(1);

    const abMessagesRes = await messagesGet(
      new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(abMessagesRes.status).toBe(200);
    const abMessages = ((await abMessagesRes.json()) as { items: ChatMessageDto[] }).items;
    const callEventMsg = abMessages.find(
      (m) => m.messageType === 'call_event' && m.callEventMeta?.callPublicId === callPublicId,
    );
    expect(callEventMsg).toBeDefined();
    expect(callEventMsg?.ciphertext).toBeNull();
    expect(callEventMsg?.cryptoHeader).toBeNull();
    expect(callEventMsg?.callEventMeta).toEqual(
      expect.objectContaining({
        callPublicId,
        callType: 'audio',
        status: 'ended',
        callerPublicId: alice.publicId,
      }),
    );

    // Kiểm chứng DB lưu đúng NULL cho ciphertext & crypto_header.
    const [dbMsgRow] = await db
      .select({
        messageType: messages.messageType,
        ciphertext: messages.ciphertext,
        cryptoHeader: messages.cryptoHeader,
      })
      .from(messages)
      .where(eq(messages.publicId, callEventMsg!.public_id));
    expect(dbMsgRow?.messageType).toBe('call_event');
    expect(dbMsgRow?.ciphertext).toBeNull();
    expect(dbMsgRow?.cryptoHeader).toBeNull();

    // 11. Bảo vệ `call_event`:
    // - Client cố giả mạo gửi `messageType: 'call_event'` qua POST /messages -> 400.
    const spoofRes = await messagesPost(
      new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          clientMsgId: 'spoof-call-event-1',
          messageType: 'call_event',
          ciphertext: 'c29tZS1jaXBoZXJ0ZXh0',
          cryptoHeader: {
            v: 1,
            alg: 'ECDH-P256+HKDF-SHA256+AES-256-GCM',
            iv: 'MTIzNDU2Nzg5MDEy',
            senderFingerprint: 'a'.repeat(64),
            recipientFingerprint: 'b'.repeat(64),
          },
        }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(spoofRes.status).toBe(400);

    // - Không cho sửa (PATCH -> 409 CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE) hay thu hồi (POST /recall -> 409 CHAT_MESSAGE_RECALL_UNSUPPORTED_TYPE).
    clearMemoryKeystoreForTesting();
    const aliceMat = await getOrCreatePrimaryDeviceKeyMaterial(alice.publicId);
    const bobMat = await getOrCreatePrimaryDeviceKeyMaterial(bob.publicId);
    const fakeEditEnvelope = await encryptDirectMessage({
      conversationPublicId: abConvId,
      senderPublicId: alice.publicId,
      clientMsgId: `call_event:${callPublicId}`,
      plaintext: 'Thử sửa thẻ cuộc gọi',
      senderDevice: aliceMat,
      recipientDevices: [
        {
          devicePublicId: generatePublicId(),
          keyFingerprint: bobMat.keyFingerprint,
          identityPublicKeyJwk: bobMat.identityPublicKeyJwk,
          signingPublicKeyJwk: bobMat.signingPublicKeyJwk,
        },
      ],
    });
    const editCallEventRes = await messageEditPatch(
      new Request(`${origin}/api/v1/messages/${callEventMsg!.public_id}`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          ciphertext: fakeEditEnvelope.ciphertext,
          cryptoHeader: fakeEditEnvelope.cryptoHeader,
        }),
      }),
      { params: Promise.resolve({ messagePublicId: callEventMsg!.public_id }) },
    );
    expect(editCallEventRes.status).toBe(409);
    expect(((await editCallEventRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE',
    );

    const recallCallEventRes = await messageRecallPost(
      new Request(`${origin}/api/v1/messages/${callEventMsg!.public_id}/recall`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: callEventMsg!.public_id }) },
    );
    expect(recallCallEventRes.status).toBe(409);
    expect(((await recallCallEventRes.json()) as { error: { code: string } }).error.code).toBe(
      'CHAT_MESSAGE_RECALL_UNSUPPORTED_TYPE',
    );

    // - Nhưng Xóa 1 phía (`DELETE /for-me`) hoạt động cho Alice mà Bob vẫn thấy thẻ cuộc gọi!
    const deleteForMeRes = await messageDeleteForMe(
      new Request(`${origin}/api/v1/messages/${callEventMsg!.public_id}/for-me`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ messagePublicId: callEventMsg!.public_id }) },
    );
    expect(deleteForMeRes.status).toBe(200);

    const aliceMsgsAfterDelete = (
      (await (
        await messagesGet(
          new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
            headers: createHeaders(alice.jar, alice.ip),
          }),
          { params: Promise.resolve({ conversationPublicId: abConvId }) },
        )
      ).json()) as { items: ChatMessageDto[] }
    ).items;
    expect(aliceMsgsAfterDelete.some((m) => m.public_id === callEventMsg!.public_id)).toBe(false);

    const bobMsgsAfterDelete = (
      (await (
        await messagesGet(
          new Request(`${origin}/api/v1/conversations/${abConvId}/messages`, {
            headers: createHeaders(bob.jar, bob.ip),
          }),
          { params: Promise.resolve({ conversationPublicId: abConvId }) },
        )
      ).json()) as { items: ChatMessageDto[] }
    ).items;
    expect(bobMsgsAfterDelete.some((m) => m.public_id === callEventMsg!.public_id)).toBe(true);

    // Xóa cả cuộc trò chuyện phía Alice cũng ẩn sạch thẻ lịch sử cuộc gọi.
    const delConvRes = await conversationDelete(
      new Request(`${origin}/api/v1/conversations/${abConvId}`, {
        method: 'DELETE',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ conversationPublicId: abConvId }) },
    );
    expect(delConvRes.status).toBe(200);

    unsubA();
    unsubB();
  });

  it('tự động quét (auto-sweep) phiên ringing > 45s thành missed & connected mất heartbeat > 120s thành ended (không kẹt CALL_BUSY), decline cooldown 429 & cắt cuộc gọi tức thì khi Block', async () => {
    const origin = getTestOrigin();
    const db = getDb();
    await ensureRlsVerifyRoleGrants();

    const alice = await seedAndLoginUser('m12_s_a', 'Alice Sweep');
    const bob = await seedAndLoginUser('m12_s_b', 'Bob Sweep');
    const convId = await createPrimaryDirectConv(alice, bob);

    // --- A. Kiểm chứng timeout 45s (`missed`) ---
    const ringCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'video' }),
      }),
    );
    expect(ringCallRes.status).toBe(201);
    const ringCallId = ((await ringCallRes.json()) as { call: { public_id: string } }).call
      .public_id;

    // Lùi `started_at` về 50 giây trước -> gọi action `timeout` từ Callee Bob phải chuyển thành `missed`.
    const fiftySecondsAgo = new Date(Date.now() - 50_000);
    await db
      .update(callSessions)
      .set({ startedAt: fiftySecondsAgo, lastHeartbeatAt: fiftySecondsAgo })
      .where(eq(callSessions.publicId, ringCallId));

    const timeoutRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${ringCallId}/action`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'timeout' }),
      }),
      { params: Promise.resolve({ callPublicId: ringCallId }) },
    );
    expect(timeoutRes.status).toBe(200);
    expect(((await timeoutRes.json()) as { call: { status: string } }).call.status).toBe('missed');

    // --- B. Kiểm chứng chống kẹt CALL_BUSY: phiên `connected` mất heartbeat > 120s được auto-sweep ---
    const staleCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'audio' }),
      }),
    );
    expect(staleCallRes.status).toBe(201);
    const staleCallId = ((await staleCallRes.json()) as { call: { public_id: string } }).call
      .public_id;

    const acceptStaleRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${staleCallId}/action`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'accept' }),
      }),
      { params: Promise.resolve({ callPublicId: staleCallId }) },
    );
    expect(acceptStaleRes.status).toBe(200);

    // Giả lập cả hai rớt mạng đột ngột: lùi `last_heartbeat_at` về 135 giây trước.
    const staleBeat = new Date(Date.now() - 135_000);
    await db
      .update(callSessions)
      .set({ connectedAt: staleBeat, lastHeartbeatAt: staleBeat })
      .where(eq(callSessions.publicId, staleCallId));

    // `app_user_has_active_call` phải trả `false` (không còn coi là đang bận).
    const activeCheck = await db.execute(
      sql`SELECT "public"."app_user_has_active_call"(${alice.id}::uuid) AS active`,
    );
    expect((activeCheck.rows[0] as { active: boolean }).active).toBe(false);

    // Alice gọi lại ngay -> phải tạo thành công `201` (không bị kẹt `409 CALL_BUSY`), đồng thời phiên cũ chuyển thành `ended`.
    const freshCallRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'audio' }),
      }),
    );
    expect(freshCallRes.status).toBe(201);
    const freshCallId = ((await freshCallRes.json()) as { call: { public_id: string } }).call
      .public_id;

    const [sweptOldRow] = await db
      .select({ status: callSessions.status })
      .from(callSessions)
      .where(eq(callSessions.publicId, staleCallId));
    expect(sweptOldRow?.status).toBe('ended');

    // --- C. Kiểm chứng Từ chối (`decline`) + Cooldown 30s (`429 RATE_LIMITED`) ---
    const declineRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${freshCallId}/action`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'decline' }),
      }),
      { params: Promise.resolve({ callPublicId: freshCallId }) },
    );
    expect(declineRes.status).toBe(200);
    expect(((await declineRes.json()) as { call: { status: string } }).call.status).toBe(
      'declined',
    );

    // Alice gọi lại dồn dập ngay sau khi bị từ chối -> 429 RATE_LIMITED.
    const redialBlockedRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'audio' }),
      }),
    );
    expect(redialBlockedRes.status).toBe(429);
    expect(((await redialBlockedRes.json()) as { error: { code: string } }).error.code).toBe(
      'RATE_LIMITED',
    );

    // Xóa cooldown để kiểm thử tiếp kịch bản Block cắt cuộc gọi tức thì.
    declineCooldownStore.clear();

    // --- D. Kiểm chứng Block cắt cuộc gọi tức thì (`SocialService.blockUser` -> `call.ended` trung tính) ---
    const activeBeforeBlockRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'video' }),
      }),
    );
    expect(activeBeforeBlockRes.status).toBe(201);
    const blockTestCallId = ((await activeBeforeBlockRes.json()) as { call: { public_id: string } })
      .call.public_id;

    const acceptBlockCallRes = await callActionPost(
      new Request(`${origin}/api/v1/calls/${blockTestCallId}/action`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ action: 'accept' }),
      }),
      { params: Promise.resolve({ callPublicId: blockTestCallId }) },
    );
    expect(acceptBlockCallRes.status).toBe(200);

    const aEndedEvents: LocalRealtimeEventMessage[] = [];
    const bEndedEvents: LocalRealtimeEventMessage[] = [];
    const unsubA = realtimeAdapter.subscribeLocal(alice.publicId, (e) => {
      if (e.event === 'call.ended') aEndedEvents.push(e);
    });
    const unsubB = realtimeAdapter.subscribeLocal(bob.publicId, (e) => {
      if (e.event === 'call.ended') bEndedEvents.push(e);
    });

    const blockRes = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    // Trạng thái DB lập tức là `ended`.
    const [afterBlockRow] = await db
      .select({ status: callSessions.status })
      .from(callSessions)
      .where(eq(callSessions.publicId, blockTestCallId));
    expect(afterBlockRow?.status).toBe('ended');

    // Cả hai phía đều nhận `call.ended` trung tính (tuyệt đối không lộ từ khóa block).
    expect(aEndedEvents.some((e) => e.data.callPublicId === blockTestCallId)).toBe(true);
    expect(bEndedEvents.some((e) => e.data.callPublicId === blockTestCallId)).toBe(true);
    expect(JSON.stringify(bEndedEvents).toLowerCase()).not.toContain('block');

    // Bob gửi signal tiếp -> bị chặn 404 đồng nhất.
    const postBlockSignal = await callSignalPost(
      new Request(`${origin}/api/v1/calls/${blockTestCallId}/signal`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          type: 'ice-candidate',
          candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
        }),
      }),
      { params: Promise.resolve({ callPublicId: blockTestCallId }) },
    );
    expect(postBlockSignal.status).toBe(404);

    unsubA();
    unsubB();
  });

  it('cưỡng chế Rate Limit chống spam gọi (> 5 cuộc gọi/phút/user trả 429 RATE_LIMITED)', async () => {
    const origin = getTestOrigin();
    const caller = await seedAndLoginUser('m12_rl_a', 'Alice RL');
    const callee = await seedAndLoginUser('m12_rl_b', 'Bob RL');
    const convId = await createPrimaryDirectConv(caller, callee);

    for (let i = 0; i < 5; i += 1) {
      const res = await createCallPost(
        new Request(`${origin}/api/v1/calls`, {
          method: 'POST',
          headers: createHeaders(caller.jar, caller.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({ conversationPublicId: convId, callType: 'audio' }),
        }),
      );
      expect(res.status).toBe(201);
      const cid = ((await res.json()) as { call: { public_id: string } }).call.public_id;
      const endRes = await callActionPost(
        new Request(`${origin}/api/v1/calls/${cid}/action`, {
          method: 'POST',
          headers: createHeaders(caller.jar, caller.ip, {
            includeCsrf: true,
            contentType: 'application/json',
          }),
          body: JSON.stringify({ action: 'end' }),
        }),
        { params: Promise.resolve({ callPublicId: cid }) },
      );
      expect(endRes.status).toBe(200);
    }

    // Cuộc gọi thứ 6 trong cùng 1 phút -> bị chặn 429 RATE_LIMITED.
    const sixthRes = await createCallPost(
      new Request(`${origin}/api/v1/calls`, {
        method: 'POST',
        headers: createHeaders(caller.jar, caller.ip, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ conversationPublicId: convId, callType: 'audio' }),
      }),
    );
    expect(sixthRes.status).toBe(429);
    expect(((await sixthRes.json()) as { error: { code: string } }).error.code).toBe(
      'RATE_LIMITED',
    );
  });
});
