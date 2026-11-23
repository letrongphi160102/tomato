import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { DELETE as notificationDelete } from '@/app/api/v1/notifications/[notificationPublicId]/route';
import { GET as notificationsGet } from '@/app/api/v1/notifications/route';
import { POST as notificationsReadPost } from '@/app/api/v1/notifications/read/route';
import { POST as presenceHeartbeatPost } from '@/app/api/v1/presence/heartbeat/route';
import { POST as presenceQueryPost } from '@/app/api/v1/presence/query/route';
import { POST as realtimeTokenPost } from '@/app/api/v1/realtime/token/route';
import { POST as blockPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import {
  DELETE as unfollowDelete,
  POST as followPost,
} from '@/app/api/v1/social/follow/[userPublicId]/route';
import { GET as followRequestsGet } from '@/app/api/v1/social/follow-requests/route';
import { POST as acceptRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/accept/route';
import { POST as declineRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/decline/route';
import { GET as privacyGet, PATCH as privacyPatch } from '@/app/api/v1/users/me/privacy/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { authIdentities, notifications, users, type UserStatus } from '@/core/db/schema';
import { type EmailMessage, type EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  REALTIME_TOKEN_TTL_MS,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
  setRealtimeRateLimiterForTesting,
} from '@/core/realtime';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
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
  NotificationRepository,
  NotificationService,
  buildNotificationDedupeKey,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
} from '@/modules/notifications';
import {
  PRESENCE_REDIS_TTL_SECONDS,
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

let ipCounter = 50;
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
    if (eqIdx <= 0) {
      continue;
    }
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

function buildCookieHeader(jar: CookieJar): string {
  const parts: string[] = [];
  if (jar.at) parts.push(`tomato_at=${jar.at}`);
  if (jar.rt) parts.push(`tomato_rt=${jar.rt}`);
  if (jar.csrf) parts.push(`tomato_csrf=${jar.csrf}`);
  return parts.join('; ');
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
  const cookieHeader = buildCookieHeader(jar);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
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
  readonly email: string;
  readonly handle: string;
  readonly password: string;
  readonly ip: string;
  jar: CookieJar;
}

const createdUserIds: string[] = [];
const TEST_PASSWORD = 'TomatoPhase2_M8_Password!99';

async function seedAndLoginUser(options: {
  readonly prefix: string;
  readonly fullName: string;
  readonly isPrivate?: boolean;
  readonly showActiveStatus?: boolean;
  readonly status?: UserStatus;
}): Promise<SeededUser> {
  const db = getDb();
  const tag = makeUniqueTag(options.prefix);
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
    fullName: options.fullName,
    bio: '',
    isPrivate: options.isPrivate ?? false,
    showActiveStatus: options.showActiveStatus ?? true,
    showReadReceipts: true,
    gender: 'other',
    dateOfBirth: '1999-05-15',
    status: options.status ?? 'active',
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
      body: JSON.stringify({
        email,
        password: TEST_PASSWORD,
      }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const jar = extractCookies(loginRes);
  expect(jar.at).toBeTruthy();
  expect(jar.csrf).toBeTruthy();

  return {
    id,
    publicId,
    email,
    handle,
    password: TEST_PASSWORD,
    ip,
    jar,
  };
}

let realtimeAdapter: InMemoryRealtimeAdapter;
let notificationRepo: NotificationRepository;

describe('Integration M8: Notifications (Partial Unique Index), Realtime & Single-Key Redis Presence', () => {
  beforeEach(() => {
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:m8:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
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
    notificationRepo = new NotificationRepository();
    const notificationService = new NotificationService({
      repository: notificationRepo,
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

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setRealtimeProviderForTesting(realtimeAdapter);
    setRealtimeRateLimiterForTesting(rateLimiter);
    setNotificationServiceForTesting(notificationService);
    setPresenceServiceForTesting(presenceService);
    setSocialServiceForTesting(socialService);
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
      await closeRedisClient();
      await closeDatabasePool();
    }
  });

  it('kiểm chứng Drizzle Partial Unique Index (`targetWhere: read_at IS NULL`) chống trùng lặp thông báo chưa đọc trên PostgreSQL thật', async () => {
    const alice = await seedAndLoginUser({ prefix: 'm8_dedupe_a', fullName: 'Alice Dedupe' });
    const bob = await seedAndLoginUser({ prefix: 'm8_dedupe_b', fullName: 'Bob Dedupe' });

    const dedupeKey = buildNotificationDedupeKey('new_follower', alice.id);
    const t1 = new Date('2026-11-23T08:00:00.000Z');
    const t2 = new Date('2026-11-23T08:05:00.000Z');
    const t3 = new Date('2026-11-23T08:10:00.000Z');

    // Lần 1: chèn thông báo chưa đọc.
    const first = await notificationRepo.upsertUnreadNotification({
      recipientId: bob.id,
      actorId: alice.id,
      type: 'new_follower',
      entityPublicId: alice.publicId,
      dedupeKey,
      now: t1,
    });

    // Lần 2 (khi vẫn chưa đọc): ON CONFLICT ... WHERE read_at IS NULL phải cập nhật dòng cũ, KHÔNG tạo dòng trùng.
    const second = await notificationRepo.upsertUnreadNotification({
      recipientId: bob.id,
      actorId: alice.id,
      type: 'new_follower',
      entityPublicId: alice.publicId,
      dedupeKey,
      now: t2,
    });

    expect(second.id).toBe(first.id);
    expect(second.publicId).toBe(first.publicId);
    expect(second.createdAt.toISOString()).toBe(t2.toISOString());

    const rowsAfterDedupe = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, bob.id));
    expect(rowsAfterDedupe).toHaveLength(1);

    // Đánh dấu đã đọc -> tạo lại cùng dedupeKey phải tạo dòng mới hợp lệ (không bị partial unique index chặn).
    await notificationRepo.markReadForRecipient(bob.id, { markAll: true }, t2);

    const third = await notificationRepo.upsertUnreadNotification({
      recipientId: bob.id,
      actorId: alice.id,
      type: 'new_follower',
      entityPublicId: alice.publicId,
      dedupeKey,
      now: t3,
    });
    expect(third.publicId).not.toBe(first.publicId);
    expect(third.readAt).toBeNull();

    const rowsAfterRead = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, bob.id));
    expect(rowsAfterRead).toHaveLength(2);
  });

  it('tự động tạo & đẩy thông báo Realtime cho Follow/Accept/Decline/Cancel, cursor pagination, mark read và xóa im lặng khi Block', async () => {
    const origin = getTestOrigin();
    const alicePrivate = await seedAndLoginUser({
      prefix: 'm8_priv_a',
      fullName: 'Alice Private',
      isPrivate: true,
    });
    const bob = await seedAndLoginUser({
      prefix: 'm8_pub_b',
      fullName: 'Bob Public',
      isPrivate: false,
    });
    const charlie = await seedAndLoginUser({
      prefix: 'm8_pub_c',
      fullName: 'Charlie Public',
      isPrivate: false,
    });

    // 1. Kiểm tra POST /api/v1/realtime/token trả đúng kênh cá nhân & TTL 15 phút.
    const tokRes = await realtimeTokenPost(
      new Request(`${origin}/api/v1/realtime/token`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, {
          includeCsrf: true,
          json: true,
        }),
        body: '{}',
      }),
    );
    expect(tokRes.status).toBe(200);
    const tokBody = (await tokRes.json()) as { channel: string; ttlMs: number };
    expect(tokBody.channel).toBe(`user:${alicePrivate.publicId}`);
    expect(tokBody.ttlMs).toBe(REALTIME_TOKEN_TTL_MS);

    // 2. Bob gửi yêu cầu follow Alice (private) -> tạo follow_request + đẩy realtime cho Alice.
    realtimeAdapter.clearPublishedEvents();
    const reqFollowRes = await followPost(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );
    expect(reqFollowRes.status).toBe(200);

    const eventsAfterRequest = realtimeAdapter.getPublishedEvents();
    expect(
      eventsAfterRequest.some(
        (ev) =>
          ev.channel === `user:${alicePrivate.publicId}` &&
          ev.event === 'notification.created' &&
          (ev.data.notification as { type: string }).type === 'follow_request',
      ),
    ).toBe(true);

    // Charlie gửi yêu cầu rồi hủy -> thông báo follow_request của Charlie bị gỡ khỏi hộp thư Alice.
    const charlieReq = await followPost(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'POST',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );
    expect(charlieReq.status).toBe(200);

    const charlieCancel = await unfollowDelete(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'DELETE',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );
    expect(charlieCancel.status).toBe(200);

    // 3. Alice kiểm tra GET /api/v1/notifications -> chỉ còn yêu cầu của Bob (followRequestPending = true).
    const aliceList1 = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=10`, {
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip),
      }),
    );
    expect(aliceList1.status).toBe(200);
    const aliceBody1 = (await aliceList1.json()) as {
      items: Array<{
        public_id: string;
        type: string;
        followRequestPending: boolean;
        actor: { public_id: string };
      }>;
      unreadCount: number;
    };
    expect(aliceBody1.unreadCount).toBe(1);
    expect(aliceBody1.items).toHaveLength(1);
    expect(aliceBody1.items[0]?.type).toBe('follow_request');
    expect(aliceBody1.items[0]?.followRequestPending).toBe(true);
    expect(aliceBody1.items[0]?.actor.public_id).toBe(bob.publicId);

    // 4. Alice chấp nhận yêu cầu của Bob -> gỡ follow_request ở Alice, tạo follow_accepted + đẩy realtime cho Bob.
    realtimeAdapter.clearPublishedEvents();
    const acceptRes = await acceptRequestPost(
      new Request(`${origin}/api/v1/social/follow-requests/${bob.publicId}/accept`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(acceptRes.status).toBe(200);

    const eventsAfterAccept = realtimeAdapter.getPublishedEvents();
    expect(
      eventsAfterAccept.some(
        (ev) =>
          ev.channel === `user:${bob.publicId}` &&
          ev.event === 'notification.created' &&
          (ev.data.notification as { type: string }).type === 'follow_accepted',
      ),
    ).toBe(true);

    // Alice follow lại Bob (public) -> Bob nhận thêm new_follower (tổng 2 thông báo chưa đọc để test cursor pagination).
    const aliceFollowBob = await followPost(
      new Request(`${origin}/api/v1/social/follow/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(aliceFollowBob.status).toBe(200);

    // Cursor pagination limit=1 tại Bob.
    const bobPage1Res = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=1`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
    );
    const bobPage1 = (await bobPage1Res.json()) as {
      items: Array<{ public_id: string; type: string }>;
      unreadCount: number;
      nextCursor: string | null;
    };
    expect(bobPage1.unreadCount).toBe(2);
    expect(bobPage1.items).toHaveLength(1);
    expect(bobPage1.nextCursor).toBeTruthy();

    const bobPage2Res = await notificationsGet(
      new Request(
        `${origin}/api/v1/notifications?limit=1&cursor=${encodeURIComponent(bobPage1.nextCursor!)}`,
        { headers: createHeaders(bob.jar, bob.ip) },
      ),
    );
    const bobPage2 = (await bobPage2Res.json()) as {
      items: Array<{ public_id: string; type: string }>;
      nextCursor: string | null;
    };
    expect(bobPage2.items).toHaveLength(1);
    expect(bobPage2.items[0]?.public_id).not.toBe(bobPage1.items[0]?.public_id);

    // Đánh dấu đã đọc 1 mục -> unreadCount giảm từ 2 xuống 1.
    const markOneRes = await notificationsReadPost(
      new Request(`${origin}/api/v1/notifications/read`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ notificationPublicIds: [bobPage1.items[0]!.public_id] }),
      }),
    );
    expect(markOneRes.status).toBe(200);
    expect(await markOneRes.json()).toEqual({ markedCount: 1, unreadCount: 1 });

    // Đánh dấu tất cả là đã đọc -> unreadCount = 0.
    const markAllRes = await notificationsReadPost(
      new Request(`${origin}/api/v1/notifications/read`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ markAll: true }),
      }),
    );
    expect(markAllRes.status).toBe(200);
    expect(await markAllRes.json()).toEqual({ markedCount: 1, unreadCount: 0 });

    // Charlie xin follow Alice rồi bị Alice từ chối -> im lặng tuyệt đối với Charlie.
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'POST',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );
    realtimeAdapter.clearPublishedEvents();
    const declineRes = await declineRequestPost(
      new Request(`${origin}/api/v1/social/follow-requests/${charlie.publicId}/decline`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: charlie.publicId }) },
    );
    expect(declineRes.status).toBe(200);
    expect(
      realtimeAdapter.getPublishedEvents().some((ev) => ev.channel === `user:${charlie.publicId}`),
    ).toBe(false);

    // 5. Alice chặn Bob -> xóa sạch toàn bộ thông báo 2 chiều, IM LẶNG tuyệt đối với Bob.
    realtimeAdapter.clearPublishedEvents();
    const blockRes = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    // Tuyệt đối không đẩy bất kỳ sự kiện Realtime nào tới kênh của Bob (người bị chặn).
    expect(
      realtimeAdapter.getPublishedEvents().some((ev) => ev.channel === `user:${bob.publicId}`),
    ).toBe(false);

    // Hộp thư thông báo của Bob không còn bất kỳ thông báo nào từ Alice.
    const bobAfterBlockRes = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=20`, {
        headers: createHeaders(bob.jar, bob.ip),
      }),
    );
    const bobAfterBlock = (await bobAfterBlockRes.json()) as {
      items: unknown[];
      unreadCount: number;
    };
    expect(bobAfterBlock.items).toHaveLength(0);
    expect(bobAfterBlock.unreadCount).toBe(0);
  });

  it('Presence 1 key Redis duy nhất (`presence:{userId}`, TTL 7 ngày), ngưỡng online 105s, làm tròn thô & cưỡng chế đối xứng khi tắt cài đặt', async () => {
    const origin = getTestOrigin();
    const redis = getRedisClient();

    const alice = await seedAndLoginUser({ prefix: 'm8_pres_a', fullName: 'Alice Presence' });
    const bob = await seedAndLoginUser({ prefix: 'm8_pres_b', fullName: 'Bob Presence' });
    const stranger = await seedAndLoginUser({ prefix: 'm8_pres_s', fullName: 'Stranger Presence' });

    // A và B theo dõi lẫn nhau (mutual follow); Stranger chỉ follow 1 chiều.
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${alice.publicId}`, {
        method: 'POST',
        headers: createHeaders(stranger.jar, stranger.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alice.publicId }) },
    );

    // 1. A & B gửi heartbeat -> xác nhận 1 key `presence:{userId}` có TTL ~ 7 ngày (604800s).
    const hbA = await presenceHeartbeatPost(
      new Request(`${origin}/api/v1/presence/heartbeat`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    expect(hbA.status).toBe(200);
    const hbB = await presenceHeartbeatPost(
      new Request(`${origin}/api/v1/presence/heartbeat`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: '{}',
      }),
    );
    expect(hbB.status).toBe(200);

    const keyA = buildPresenceRedisKey(alice.id);
    const storedValA = await redis.get(keyA);
    const pttlMsA = await redis.pttl(keyA);
    expect(Number(storedValA)).toBeGreaterThan(0);
    expect(pttlMsA).toBeGreaterThan((PRESENCE_REDIS_TTL_SECONDS - 120) * 1000);
    expect(pttlMsA).toBeLessThanOrEqual(PRESENCE_REDIS_TTL_SECONDS * 1000);

    // 2. A truy vấn [B, Stranger] -> thấy B 'Đang hoạt động', Stranger là null.
    const q1Res = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [bob.publicId, stranger.publicId] }),
      }),
    );
    expect(q1Res.status).toBe(200);
    const q1Body = (await q1Res.json()) as {
      viewerActiveStatusEnabled: boolean;
      presences: Record<string, { isOnline: boolean; bucket: string; label: string } | null>;
    };
    expect(q1Body.viewerActiveStatusEnabled).toBe(true);
    expect(q1Body.presences[bob.publicId]).toEqual({
      isOnline: true,
      bucket: 'active_now',
      label: 'Đang hoạt động',
    });
    expect(q1Body.presences[stranger.publicId]).toBeNull();

    // 3. Giả lập B offline 12 phút trước -> làm tròn thô xuống 'Hoạt động 10 phút trước'.
    await redis.set(buildPresenceRedisKey(bob.id), String(Date.now() - 12 * 60_000), {
      ex: PRESENCE_REDIS_TTL_SECONDS,
    });
    const q2Res = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [bob.publicId] }),
      }),
    );
    const q2Body = (await q2Res.json()) as {
      presences: Record<string, { isOnline: boolean; bucket: string; label: string } | null>;
    };
    expect(q2Body.presences[bob.publicId]).toEqual({
      isOnline: false,
      bucket: 'minutes',
      label: 'Hoạt động 10 phút trước',
    });

    // 4. A tắt `showActiveStatus` và `showReadReceipts` qua PATCH /api/v1/users/me/privacy:
    //    - Key Redis `presence:{A.id}` bị xóa ngay lập tức.
    //    - Cả A truy vấn B lẫn B truy vấn A đều trả null (đối xứng 100% ở Server).
    const patchRes = await privacyPatch(
      new Request(`${origin}/api/v1/users/me/privacy`, {
        method: 'PATCH',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ showActiveStatus: false, showReadReceipts: false }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      privacy: { showActiveStatus: boolean; showReadReceipts: boolean };
    };
    expect(patchBody.privacy.showActiveStatus).toBe(false);
    expect(patchBody.privacy.showReadReceipts).toBe(false);

    // Xác nhận GET /api/v1/users/me/privacy lưu đúng 2 cờ mới.
    const getPrivacyRes = await privacyGet(
      new Request(`${origin}/api/v1/users/me/privacy`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    const getPrivacyBody = (await getPrivacyRes.json()) as {
      privacy: { showActiveStatus: boolean; showReadReceipts: boolean };
    };
    expect(getPrivacyBody.privacy.showActiveStatus).toBe(false);
    expect(getPrivacyBody.privacy.showReadReceipts).toBe(false);

    // Key Redis duy nhất của A đã bị DEL lập tức.
    expect(await redis.get(keyA)).toBeNull();

    // Đối xứng: A hỏi B -> null; B hỏi A -> null.
    const aAsksB = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [bob.publicId] }),
      }),
    );
    expect((await aAsksB.json()).presences[bob.publicId]).toBeNull();

    const bAsksA = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ userPublicIds: [alice.publicId] }),
      }),
    );
    expect((await bAsksA.json()).presences[alice.publicId]).toBeNull();
  });

  it('DELETE /api/v1/notifications/:publicId: xóa thông báo chưa đọc/đã đọc, giữ nguyên follow_request, chặn BOLA 404 và phát notification.deleted đúng kênh', async () => {
    const origin = getTestOrigin();
    const alicePrivate = await seedAndLoginUser({
      prefix: 'm8_del_a',
      fullName: 'Alice Delete Target',
      isPrivate: true,
    });
    const bob = await seedAndLoginUser({
      prefix: 'm8_del_b',
      fullName: 'Bob Requester',
      isPrivate: false,
    });
    const charlie = await seedAndLoginUser({
      prefix: 'm8_del_c',
      fullName: 'Charlie Requester',
      isPrivate: false,
    });

    // Bob và Charlie cùng gửi yêu cầu follow tới Alice (tạo 2 thông báo chưa đọc trên chuông của Alice).
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );
    await followPost(
      new Request(`${origin}/api/v1/social/follow/${alicePrivate.publicId}`, {
        method: 'POST',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: alicePrivate.publicId }) },
    );

    const listBeforeRes = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=10`, {
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip),
      }),
    );
    const listBefore = (await listBeforeRes.json()) as {
      items: Array<{ public_id: string; actor: { public_id: string } }>;
      unreadCount: number;
    };
    expect(listBefore.items).toHaveLength(2);
    expect(listBefore.unreadCount).toBe(2);

    const bobNotif = listBefore.items.find((i) => i.actor.public_id === bob.publicId)!;
    const charlieNotif = listBefore.items.find((i) => i.actor.public_id === charlie.publicId)!;

    // 1. BOLA: Bob cố xóa thông báo của Alice -> 404, dữ liệu của Alice không bị ảnh hưởng.
    realtimeAdapter.clearPublishedEvents();
    const bolaRes = await notificationDelete(
      new Request(`${origin}/api/v1/notifications/${bobNotif.public_id}`, {
        method: 'DELETE',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ notificationPublicId: bobNotif.public_id }) },
    );
    expect(bolaRes.status).toBe(404);
    expect(realtimeAdapter.getPublishedEvents()).toHaveLength(0);

    // 2. Alice xóa thông báo CHƯA ĐỌC của Bob -> 200, unreadCount giảm 2 -> 1, phát notification.deleted chỉ tới Alice.
    realtimeAdapter.clearPublishedEvents();
    const delUnreadRes = await notificationDelete(
      new Request(`${origin}/api/v1/notifications/${bobNotif.public_id}`, {
        method: 'DELETE',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ notificationPublicId: bobNotif.public_id }) },
    );
    expect(delUnreadRes.status).toBe(200);
    expect(await delUnreadRes.json()).toEqual({
      deleted: true,
      notificationPublicId: bobNotif.public_id,
      unreadCount: 1,
    });

    const eventsAfterDelete = realtimeAdapter.getPublishedEvents();
    expect(eventsAfterDelete).toHaveLength(1);
    expect(eventsAfterDelete[0]?.channel).toBe(`user:${alicePrivate.publicId}`);
    expect(eventsAfterDelete[0]?.event).toBe('notification.deleted');
    expect(eventsAfterDelete[0]?.data).toEqual({
      notificationPublicId: bobNotif.public_id,
      unreadCount: 1,
    });

    // Ranh giới nghiệp vụ: yêu cầu follow của Bob trong bảng `follows` vẫn còn nguyên dù thông báo đã bị xóa!
    const followRequestsRes = await followRequestsGet(
      new Request(`${origin}/api/v1/social/follow-requests?limit=10`, {
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip),
      }),
    );
    const followRequestsBody = (await followRequestsRes.json()) as {
      items: Array<{ public_id: string }>;
    };
    expect(followRequestsBody.items.some((req) => req.public_id === bob.publicId)).toBe(true);

    // Xóa lại cùng ID lần 2 -> 404.
    const delAgainRes = await notificationDelete(
      new Request(`${origin}/api/v1/notifications/${bobNotif.public_id}`, {
        method: 'DELETE',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ notificationPublicId: bobNotif.public_id }) },
    );
    expect(delAgainRes.status).toBe(404);

    // 3. Đánh dấu đã đọc thông báo của Charlie (unreadCount: 1 -> 0), rồi xóa thông báo ĐÃ ĐỌC -> unreadCount vẫn giữ 0.
    await notificationsReadPost(
      new Request(`${origin}/api/v1/notifications/read`, {
        method: 'POST',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, {
          includeCsrf: true,
          json: true,
        }),
        body: JSON.stringify({ notificationPublicIds: [charlieNotif.public_id] }),
      }),
    );

    const delReadRes = await notificationDelete(
      new Request(`${origin}/api/v1/notifications/${charlieNotif.public_id}`, {
        method: 'DELETE',
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ notificationPublicId: charlieNotif.public_id }) },
    );
    expect(delReadRes.status).toBe(200);
    expect(await delReadRes.json()).toEqual({
      deleted: true,
      notificationPublicId: charlieNotif.public_id,
      unreadCount: 0,
    });

    // Danh sách GET /api/v1/notifications giờ rỗng hoàn toàn.
    const listAfterRes = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=10`, {
        headers: createHeaders(alicePrivate.jar, alicePrivate.ip),
      }),
    );
    const listAfter = (await listAfterRes.json()) as { items: unknown[]; unreadCount: number };
    expect(listAfter.items).toHaveLength(0);
    expect(listAfter.unreadCount).toBe(0);

    // 4. Phát sinh lại cùng dedupe_key sau khi xóa cứng -> upsert thành công không xung đột partial unique index.
    const recreated = await notificationRepo.upsertUnreadNotification({
      recipientId: alicePrivate.id,
      actorId: bob.id,
      type: 'follow_request',
      entityPublicId: bob.publicId,
      dedupeKey: buildNotificationDedupeKey('follow_request', bob.id),
      now: new Date(),
    });
    expect(recreated.publicId).not.toBe(bobNotif.public_id);
  });
});
