import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as notificationsGet } from '@/app/api/v1/notifications/route';
import { POST as notificationsReadPost } from '@/app/api/v1/notifications/read/route';
import { POST as presenceHeartbeatPost } from '@/app/api/v1/presence/heartbeat/route';
import { POST as presenceQueryPost } from '@/app/api/v1/presence/query/route';
import { GET as realtimeStreamGet } from '@/app/api/v1/realtime/stream/route';
import { POST as realtimeTokenPost } from '@/app/api/v1/realtime/token/route';
import { getEnv } from '@/core/config/env';
import type { SessionRow, UserRow } from '@/core/db/schema';
import {
  AblyRealtimeAdapter,
  InMemoryRealtimeAdapter,
  REALTIME_TOKEN_TTL_MS,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
  setRealtimeRateLimiterForTesting,
} from '@/core/realtime';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
  type NotificationRepository,
} from '@/modules/notifications';
import {
  PresenceService,
  buildPresenceRedisKey,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
  type PresenceRepository,
} from '@/modules/presence';
import { proxy } from '@/proxy';

const TEST_CSRF = 'synthetic-csrf-token-value-for-m8-security-tests';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T10:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'user_a',
    handle: 'user_a',
    handleNormalized: 'user_a',
    fullName: 'User A',
    bio: '',
    avatarUrl: null,
    avatarStorageKey: 'avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp',
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 1,
    followingCount: 1,
    handleChangedAt: null,
    gender: 'female',
    dateOfBirth: '1999-03-12',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(user: UserRow): AuthenticatedPrincipal {
  const now = new Date('2026-11-23T10:00:00.000Z');
  const session: SessionRow = {
    id: '0195a000-0000-7000-8000-000000000080',
    publicId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: user.id,
    familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    refreshTokenHash: 'synthetic-hash',
    deviceInfo: 'Chrome on Windows',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  };
  return { user, session };
}

function createAllowAllRateLimiter() {
  return {
    consume: vi.fn().mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 59,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
    }),
  };
}

function createAuthHeaders(origin: string, accessToken: string, includeCsrf = true) {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `tomato_at=${accessToken}; tomato_csrf=${TEST_CSRF}`,
    'Content-Type': 'application/json',
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetRealtimeProviderForTesting();
  resetNotificationServiceForTesting();
  resetPresenceServiceForTesting();
  vi.restoreAllMocks();
});

describe('Security M8: Realtime Channel BOLA, Presence Đối xứng, Notifications & CSRF 3 lớp', () => {
  const userA = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_m8',
    handleNormalized: 'alice_m8',
    fullName: 'Alice M8',
  });
  const userB = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_m8',
    handleNormalized: 'bob_m8',
    fullName: 'Bob M8',
  });
  const userC = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'charlie_blocked',
    handleNormalized: 'charlie_blocked',
    fullName: 'Charlie Blocked',
  });
  const userD = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000004',
    publicId: '44444444-4444-4444-8444-444444444444',
    handle: 'david_stranger',
    handleNormalized: 'david_stranger',
    fullName: 'David Stranger',
  });

  function installSessionLookup(map: Record<string, AuthenticatedPrincipal>) {
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn(async (token?: string | null) => {
        if (token && map[token]) {
          return map[token];
        }
        const { AuthDomainError } = await import('@/modules/auth/auth.errors');
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Phiên đăng nhập không hợp lệ.',
        });
      }),
    } as unknown as SessionService);
  }

  it('từ chối ẩn danh (Anon -> 401) + Cache-Control: no-store trên mọi endpoint M8 và gắn header qua proxy()', async () => {
    const origin = getTestOrigin();
    const validCsrfNoAuth = {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `tomato_csrf=${TEST_CSRF}`,
      [CSRF_HEADER_NAME]: TEST_CSRF,
      'Content-Type': 'application/json',
    };

    const responses = await Promise.all([
      notificationsGet(new Request(`${origin}/api/v1/notifications`)),
      notificationsReadPost(
        new Request(`${origin}/api/v1/notifications/read`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: JSON.stringify({ markAll: true }),
        }),
      ),
      realtimeTokenPost(
        new Request(`${origin}/api/v1/realtime/token`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
      ),
      realtimeStreamGet(new Request(`${origin}/api/v1/realtime/stream`)),
      presenceHeartbeatPost(
        new Request(`${origin}/api/v1/presence/heartbeat`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: '{}',
        }),
      ),
      presenceQueryPost(
        new Request(`${origin}/api/v1/presence/query`, {
          method: 'POST',
          headers: validCsrfNoAuth,
          body: JSON.stringify({ userPublicIds: [userB.publicId] }),
        }),
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }

    for (const path of [
      '/api/v1/notifications',
      '/api/v1/realtime/token',
      '/api/v1/presence/query',
    ]) {
      const proxyRes = proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(proxyRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }
  });

  it('cưỡng chế CSRF 3 lớp (403) trên toàn bộ endpoint ghi M8', async () => {
    const origin = getTestOrigin();
    const badCsrfHeaders = createAuthHeaders(origin, 'tok-a', false);

    const responses = await Promise.all([
      realtimeTokenPost(
        new Request(`${origin}/api/v1/realtime/token`, {
          method: 'POST',
          headers: badCsrfHeaders,
          body: '{}',
        }),
      ),
      notificationsReadPost(
        new Request(`${origin}/api/v1/notifications/read`, {
          method: 'POST',
          headers: badCsrfHeaders,
          body: JSON.stringify({ markAll: true }),
        }),
      ),
      presenceHeartbeatPost(
        new Request(`${origin}/api/v1/presence/heartbeat`, {
          method: 'POST',
          headers: badCsrfHeaders,
          body: '{}',
        }),
      ),
      presenceQueryPost(
        new Request(`${origin}/api/v1/presence/query`, {
          method: 'POST',
          headers: badCsrfHeaders,
          body: JSON.stringify({ userPublicIds: [userB.publicId] }),
        }),
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CSRF_VALIDATION_FAILED');
    }
  });

  it('chống BOLA kênh Realtime: Token chỉ cấp quyền subscribe đúng user:{actor.publicId} (TTL 15p), chặn tham số lạ và cô lập luồng SSE kèm dọn dẹp khi abort', async () => {
    const origin = getTestOrigin();
    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
    });
    setRealtimeRateLimiterForTesting(createAllowAllRateLimiter());

    // 1. Kiểm chứng với AblyRealtimeAdapter (cưỡng chế capability + TTL 15 phút).
    const mockAblyRest = {
      auth: {
        createTokenRequest: vi.fn(async (params: Record<string, unknown>) => ({
          keyName: 'syntheticApp.syntheticKey',
          ttl: Number(params.ttl),
          timestamp: 1_760_000_000_000,
          capability: String(params.capability),
          clientId: String(params.clientId),
          nonce: 'synthetic-nonce',
          mac: 'synthetic-mac',
        })),
      },
      channels: {
        get: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })),
      },
    };
    setRealtimeProviderForTesting(
      new AblyRealtimeAdapter({
        apiKey: 'syntheticApp.syntheticKey:syntheticSecretValueNotReal',
        client: mockAblyRest as never,
      }),
    );

    // Cố truyền kênh người khác trong body -> bị chặn 400 (BOPLA .strict()).
    const tamperedBodyRes = await realtimeTokenPost(
      new Request(`${origin}/api/v1/realtime/token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ channel: `user:${userB.publicId}` }),
      }),
    );
    expect(tamperedBodyRes.status).toBe(400);

    // Yêu cầu hợp lệ của User A -> chỉ nhận đúng kênh user:{A.publicId} + subscribe-only + TTL 15 phút.
    const tokenRes = await realtimeTokenPost(
      new Request(`${origin}/api/v1/realtime/token`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: '{}',
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      provider: string;
      channel: string;
      ttlMs: number;
      tokenRequest: { capability: string; clientId: string };
    };
    expect(tokenBody.provider).toBe('ably');
    expect(tokenBody.channel).toBe(`user:${userA.publicId}`);
    expect(tokenBody.ttlMs).toBe(REALTIME_TOKEN_TTL_MS);
    expect(tokenBody.tokenRequest.clientId).toBe(userA.publicId);
    expect(JSON.parse(tokenBody.tokenRequest.capability)).toEqual({
      [`user:${userA.publicId}`]: ['subscribe'],
    });

    // Khi Ably đang hoạt động -> route SSE local trả 404 đồng nhất.
    const sseWhileAbly = await realtimeStreamGet(
      new Request(`${origin}/api/v1/realtime/stream`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
    );
    expect(sseWhileAbly.status).toBe(404);

    // 2. Kiểm chứng cô lập kênh và dọn dẹp tài nguyên trên SSE local (InMemoryRealtimeAdapter).
    const localAdapter = new InMemoryRealtimeAdapter({ isolated: true });
    setRealtimeProviderForTesting(localAdapter);

    // Truyền query ?channel=user:{B} bị từ chối 400.
    const tamperedQueryRes = await realtimeStreamGet(
      new Request(`${origin}/api/v1/realtime/stream?channel=user:${userB.publicId}`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
    );
    expect(tamperedQueryRes.status).toBe(400);

    const abortController = new AbortController();
    const sseRes = await realtimeStreamGet(
      new Request(`${origin}/api/v1/realtime/stream`, {
        headers: { cookie: 'tomato_at=tok-a' },
        signal: abortController.signal,
      }),
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream');
    expect(localAdapter.getListenerCount(userA.publicId)).toBe(1);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toContain(`user:${userA.publicId}`);

    // Đẩy sự kiện tới User B -> User A TUYỆT ĐỐI KHÔNG nhận được; đẩy tới User A -> User A nhận được.
    await localAdapter.publishToUser(userB.publicId, 'notification.created', {
      unreadCount: 99,
      marker: 'for-b-only',
    });
    await localAdapter.publishToUser(userA.publicId, 'notification.created', {
      unreadCount: 1,
      marker: 'for-a-only',
    });

    const secondChunk = await reader.read();
    const text = decoder.decode(secondChunk.value);
    expect(text).toContain('for-a-only');
    expect(text).not.toContain('for-b-only');

    // Khi client ngắt kết nối (abort) -> gỡ listener ngay lập tức, không rò rỉ bộ nhớ.
    abortController.abort();
    await reader.cancel().catch(() => undefined);
    expect(localAdapter.getListenerCount(userA.publicId)).toBe(0);
  });

  it('cưỡng chế Presence đối xứng 2 chiều, chặn Block/Stranger đồng nhất null, chống theo dõi 429 & không lộ timestamp từng giây', async () => {
    const origin = getTestOrigin();
    const nowMs = 1_760_000_000_000;

    const mutableUsers = new Map<string, UserRow>([
      [userA.id, { ...userA }],
      [userB.id, { ...userB }],
      [userC.id, { ...userC }],
      [userD.id, { ...userD }],
    ]);

    const redisStore = new Map<string, string>([
      [buildPresenceRedisKey(userA.id), String(nowMs - 20_000)],
      [buildPresenceRedisKey(userB.id), String(nowMs - 30_000)],
      [buildPresenceRedisKey(userC.id), String(nowMs - 10_000)],
      [buildPresenceRedisKey(userD.id), String(nowMs - 10_000)],
    ]);

    const mockRedis = {
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      mget: vi.fn(async (...keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
      set: vi.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
        return 'OK' as const;
      }),
      del: vi.fn(async (...keys: string[]) => {
        let count = 0;
        for (const k of keys) {
          if (redisStore.delete(k)) count += 1;
        }
        return count;
      }),
    };

    const mockPresenceRepo: PresenceRepository = {
      findUserPresenceRecordById: vi.fn(async (id: string) => mutableUsers.get(id) ?? null),
      findUsersPresenceRecordsByPublicIds: vi.fn(async (pids: readonly string[]) =>
        Array.from(mutableUsers.values()).filter((u) => pids.includes(u.publicId)),
      ),
      findBlockedPeerIds: vi.fn(async (viewerId: string) => {
        if (viewerId === userA.id) return new Set([userC.id]);
        if (viewerId === userC.id) return new Set([userA.id]);
        return new Set<string>();
      }),
      findMutualFollowPeerIds: vi.fn(async (viewerId: string) => {
        // Chỉ A <-> B theo dõi lẫn nhau; D là người lạ.
        if (viewerId === userA.id) return new Set([userB.id]);
        if (viewerId === userB.id) return new Set([userA.id]);
        return new Set<string>();
      }),
      findPrimaryConversationPeerIds: vi.fn(async () => new Set<string>()),
    } as unknown as PresenceRepository;

    const rateLimiter = createAllowAllRateLimiter();
    setPresenceServiceForTesting(
      new PresenceService({
        repository: mockPresenceRepo,
        redis: mockRedis,
        rateLimiter,
        now: () => nowMs,
      }),
    );

    installSessionLookup({
      'tok-a': makePrincipal(userA),
      'tok-b': makePrincipal(userB),
    });

    const nonexistentId = '99999999-9999-4999-8999-999999999999';

    // 1. Cả A & B bật -> A thấy B 'Đang hoạt động', nhưng C (bị chặn), D (người lạ) và ID ảo đều trả null đồng nhất.
    const res1 = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({
          userPublicIds: [userB.publicId, userC.publicId, userD.publicId, nonexistentId],
        }),
      }),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      viewerActiveStatusEnabled: boolean;
      presences: Record<string, { isOnline: boolean; bucket: string; label: string } | null>;
    };
    expect(body1.viewerActiveStatusEnabled).toBe(true);
    expect(body1.presences[userB.publicId]).toEqual({
      isOnline: true,
      bucket: 'active_now',
      label: 'Đang hoạt động',
    });
    expect(body1.presences[userC.publicId]).toBeNull();
    expect(body1.presences[userD.publicId]).toBeNull();
    expect(body1.presences[nonexistentId]).toBeNull();
    expect(JSON.stringify(body1)).not.toContain(String(nowMs - 30_000));
    expect(JSON.stringify(body1)).not.toContain(userB.id);

    // 2. A tắt `showActiveStatus` -> Đối xứng: A không thấy B VÀ B cũng không thấy A.
    mutableUsers.set(userA.id, { ...userA, showActiveStatus: false });

    const aQueriesB = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ userPublicIds: [userB.publicId] }),
      }),
    );
    const aQueriesBBody = (await aQueriesB.json()) as {
      viewerActiveStatusEnabled: boolean;
      presences: Record<string, unknown>;
    };
    expect(aQueriesBBody.viewerActiveStatusEnabled).toBe(false);
    expect(aQueriesBBody.presences[userB.publicId]).toBeNull();

    const bQueriesA = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({ userPublicIds: [userA.publicId] }),
      }),
    );
    const bQueriesABody = (await bQueriesA.json()) as {
      viewerActiveStatusEnabled: boolean;
      presences: Record<string, unknown>;
    };
    expect(bQueriesABody.viewerActiveStatusEnabled).toBe(true);
    expect(bQueriesABody.presences[userA.publicId]).toBeNull();

    // 3. Heartbeat khi A đang tắt -> xóa key `presence:{A.id}` trong Redis và không ghi mới.
    const hbRes = await presenceHeartbeatPost(
      new Request(`${origin}/api/v1/presence/heartbeat`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: '{}',
      }),
    );
    expect(hbRes.status).toBe(200);
    expect(redisStore.has(buildPresenceRedisKey(userA.id))).toBe(false);

    // 4. Vượt ngưỡng rate limit truy vấn Presence -> trả 429 kèm Retry-After.
    rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: nowMs + 45_000,
      retryAfterSeconds: 45,
    });
    const rateLimitedRes = await presenceQueryPost(
      new Request(`${origin}/api/v1/presence/query`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-b'),
        body: JSON.stringify({ userPublicIds: [userA.publicId] }),
      }),
    );
    expect(rateLimitedRes.status).toBe(429);
    expect(rateLimitedRes.headers.get('Retry-After')).toBe('45');
  });

  it('DTO Notifications tuyệt đối không lộ UUIDv7 id hay trường nội bộ và từ chối field lạ', async () => {
    const origin = getTestOrigin();
    installSessionLookup({ 'tok-a': makePrincipal(userA) });

    const notifPublicId = '55555555-5555-4555-8555-555555555555';
    const mockRepo: Partial<NotificationRepository> = {
      listForRecipient: vi.fn(async () => [
        {
          publicId: notifPublicId,
          type: 'follow_request' as const,
          entityPublicId: userB.publicId,
          readAt: null,
          createdAt: new Date('2026-11-23T11:00:00.000Z'),
          cursorCreatedAtIso: '2026-11-23T11:00:00.000000Z',
          actorPublicId: userB.publicId,
          actorHandle: userB.handle,
          actorFullName: userB.fullName,
          actorAvatarUrl: null,
          actorIsPrivate: false,
          followRequestPending: true,
        },
      ]),
      countUnreadForRecipient: vi.fn(async () => 1),
      markReadForRecipient: vi.fn(async () => [notifPublicId]),
    };

    setNotificationServiceForTesting(
      new NotificationService({
        repository: mockRepo as NotificationRepository,
        rateLimiter: createAllowAllRateLimiter(),
        realtimeProvider: new InMemoryRealtimeAdapter({ isolated: true }),
      }),
    );

    const listRes = await notificationsGet(
      new Request(`${origin}/api/v1/notifications?limit=10`, {
        headers: { cookie: 'tomato_at=tok-a' },
      }),
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain(userA.id);
    expect(listText).not.toContain(userB.id);
    expect(listText).not.toContain('avatarStorageKey');

    const badReadRes = await notificationsReadPost(
      new Request(`${origin}/api/v1/notifications/read`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-a'),
        body: JSON.stringify({ markAll: true, recipientId: userB.id }),
      }),
    );
    expect(badReadRes.status).toBe(400);
  });
});
