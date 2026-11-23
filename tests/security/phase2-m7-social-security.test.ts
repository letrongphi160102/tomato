import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFoundMock, redirectMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    const error = new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    (error as Error & { digest?: string }).digest = 'NEXT_HTTP_ERROR_FALLBACK;404';
    throw error;
  }),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
}));

const { resolveServerAuthStateMock } = vi.hoisted(() => ({
  resolveServerAuthStateMock: vi.fn(),
}));

vi.mock('@/modules/auth/server-session', () => ({
  resolveServerAuthState: resolveServerAuthStateMock,
}));

import UserProfilePage from '@/app/(dashboard)/u/[handle]/page';
import {
  DELETE as blockDelete,
  POST as blockPost,
} from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { GET as blocksListGet } from '@/app/api/v1/social/blocks/route';
import {
  DELETE as unfollowDelete,
  POST as followPost,
} from '@/app/api/v1/social/follow/[userPublicId]/route';
import { POST as acceptRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/accept/route';
import { POST as declineRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/decline/route';
import { GET as followRequestsGet } from '@/app/api/v1/social/follow-requests/route';
import { DELETE as removeFollowerDelete } from '@/app/api/v1/social/followers/[userPublicId]/route';
import { GET as followersListGet } from '@/app/api/v1/social/users/[userPublicId]/followers/route';
import { GET as followingListGet } from '@/app/api/v1/social/users/[userPublicId]/following/route';
import { GET as userByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { GET as privacyGet, PATCH as privacyPatch } from '@/app/api/v1/users/me/privacy/route';
import { getEnv } from '@/core/config/env';
import type { SessionRow, UserRow } from '@/core/db/schema';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  ProfileService,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
  type ProfileRepository,
} from '@/modules/profile';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
  type SocialRelationshipSnapshot,
  type SocialRepository,
} from '@/modules/social';
import { proxy } from '@/proxy';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

const TEST_CSRF = 'synthetic-csrf-token-value-for-m7-security-tests';

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T10:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'user_a_private',
    handle: 'user_a_private',
    handleNormalized: 'user_a_private',
    fullName: 'User A Private',
    bio: 'Tiểu sử riêng tư',
    avatarUrl: null,
    avatarStorageKey: 'avatars/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
    isPrivate: true,
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

afterEach(() => {
  resetSessionServiceForTesting();
  resetProfileServiceForTesting();
  resetSocialServiceForTesting();
  notFoundMock.mockClear();
  redirectMock.mockClear();
  resolveServerAuthStateMock.mockReset();
  vi.restoreAllMocks();
});

describe('Security M7: Ma trận 5 nhân vật (BOLA/IDOR), CSRF 3 lớp, BOPLA & SSR 404', () => {
  const userA = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_private',
    handleNormalized: 'alice_private',
    fullName: 'Alice Private',
    isPrivate: true,
  });
  const userB = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_follower',
    handleNormalized: 'bob_follower',
    fullName: 'Bob Approved Follower',
    isPrivate: false,
  });
  const userC = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000003',
    publicId: '33333333-3333-4333-8333-333333333333',
    handle: 'charlie_blocked',
    handleNormalized: 'charlie_blocked',
    fullName: 'Charlie Blocked',
    isPrivate: false,
  });
  const userD = makeUserRow({
    id: '0195a000-0000-7000-8000-000000000004',
    publicId: '44444444-4444-4444-8444-444444444444',
    handle: 'david_stranger',
    handleNormalized: 'david_stranger',
    fullName: 'David Stranger',
    isPrivate: false,
  });

  function buildRelationshipResolver() {
    return vi.fn(async (actorId: string, targetId: string): Promise<SocialRelationshipSnapshot> => {
      // User B đã được duyệt theo dõi User A.
      if (actorId === userB.id && targetId === userA.id) {
        return {
          ...EMPTY_SOCIAL_RELATIONSHIP,
          actorFollowStatus: 'following',
          targetFollowStatus: 'none',
        };
      }
      // User C bị User A chặn.
      if (actorId === userC.id && targetId === userA.id) {
        return {
          ...EMPTY_SOCIAL_RELATIONSHIP,
          blockedByTarget: true,
        };
      }
      if (actorId === userA.id && targetId === userC.id) {
        return {
          ...EMPTY_SOCIAL_RELATIONSHIP,
          blockedByActor: true,
        };
      }
      // User D là người lạ đối với User A (và A chỉ mới gửi 'requested' tới D — KHÔNG được tính là followedBy!).
      if (actorId === userD.id && targetId === userA.id) {
        return {
          ...EMPTY_SOCIAL_RELATIONSHIP,
          actorFollowStatus: 'none',
          targetFollowStatus: 'requested',
        };
      }
      return EMPTY_SOCIAL_RELATIONSHIP;
    });
  }

  it('từ chối ẩn danh (Anon -> 401) kèm Cache-Control: no-store trên toàn bộ endpoint M7', async () => {
    const origin = getTestOrigin();
    const targetId = userA.publicId;

    const responses = await Promise.all([
      followRequestsGet(new Request(`${origin}/api/v1/social/follow-requests`)),
      followersListGet(new Request(`${origin}/api/v1/social/users/${targetId}/followers`), {
        params: Promise.resolve({ userPublicId: targetId }),
      }),
      followingListGet(new Request(`${origin}/api/v1/social/users/${targetId}/following`), {
        params: Promise.resolve({ userPublicId: targetId }),
      }),
      blocksListGet(new Request(`${origin}/api/v1/social/blocks`)),
      privacyGet(new Request(`${origin}/api/v1/users/me/privacy`)),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }
  });

  it('cưỡng chế CSRF 3 lớp (403) cho toàn bộ endpoint ghi M7 khi thiếu/sai Origin hoặc X-CSRF-Token', async () => {
    const origin = getTestOrigin();
    const targetId = userA.publicId;
    const ctx = { params: Promise.resolve({ userPublicId: targetId }) };

    const missingOriginHeaders = { 'Content-Type': 'application/json' };
    const badCsrfHeaders = {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `tomato_csrf=${TEST_CSRF}`,
      'Content-Type': 'application/json',
    };

    const blockedResponses = await Promise.all([
      followPost(
        new Request(`${origin}/api/v1/social/follow/${targetId}`, {
          method: 'POST',
          headers: missingOriginHeaders,
        }),
        ctx,
      ),
      unfollowDelete(
        new Request(`${origin}/api/v1/social/follow/${targetId}`, {
          method: 'DELETE',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      acceptRequestPost(
        new Request(`${origin}/api/v1/social/follow-requests/${targetId}/accept`, {
          method: 'POST',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      declineRequestPost(
        new Request(`${origin}/api/v1/social/follow-requests/${targetId}/decline`, {
          method: 'POST',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      removeFollowerDelete(
        new Request(`${origin}/api/v1/social/followers/${targetId}`, {
          method: 'DELETE',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      blockPost(
        new Request(`${origin}/api/v1/social/blocks/${targetId}`, {
          method: 'POST',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      blockDelete(
        new Request(`${origin}/api/v1/social/blocks/${targetId}`, {
          method: 'DELETE',
          headers: badCsrfHeaders,
        }),
        ctx,
      ),
      privacyPatch(
        new Request(`${origin}/api/v1/users/me/privacy`, {
          method: 'PATCH',
          headers: badCsrfHeaders,
          body: JSON.stringify({ isPrivate: true }),
        }),
      ),
    ]);

    for (const res of blockedResponses) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CSRF_VALIDATION_FAILED');
    }
  });

  it('cưỡng chế ma trận BOLA: User C (bị chặn) & User D (người lạ Private) nhận 404 đồng nhất, User B được duyệt xem được & DTO không lộ trường nội bộ', async () => {
    const origin = getTestOrigin();
    const getRel = buildRelationshipResolver();

    const usersByPublicId = new Map<string, UserRow>([
      [userA.publicId, userA],
      [userB.publicId, userB],
      [userC.publicId, userC],
      [userD.publicId, userD],
    ]);
    const usersByHandle = new Map<string, UserRow>([
      [userA.handleNormalized, userA],
      [userB.handleNormalized, userB],
      [userC.handleNormalized, userC],
      [userD.handleNormalized, userD],
    ]);

    const mockSocialRepo = {
      findUserByPublicId: vi.fn(async (pid: string) => usersByPublicId.get(pid) ?? null),
      getRelationshipSnapshot: getRel,
      listFollowers: vi.fn(async () => [
        {
          publicId: userB.publicId,
          handle: userB.handle,
          fullName: userB.fullName,
          avatarUrl: null,
          isPrivate: false,
          viewerFollowStatus: 'none' as const,
          followedBy: false,
          isSelf: true,
          cursorCreatedAtIso: '2026-11-23T10:00:00.000000Z',
        },
      ]),
      listFollowing: vi.fn(async () => []),
      getDb: vi.fn(() => ({
        transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
      })),
      lockUsersInCanonicalOrder: vi.fn(async (ids: string[]) => {
        const map = new Map<string, UserRow>();
        for (const u of [userA, userB, userC, userD]) {
          if (ids.includes(u.id)) map.set(u.id, u);
        }
        return map;
      }),
    } as unknown as SocialRepository;

    const mockProfileRepo = {
      findUserByHandleNormalized: vi.fn(async (h: string) => usersByHandle.get(h) ?? null),
    } as unknown as ProfileRepository;

    setSocialServiceForTesting(
      new SocialService({
        repository: mockSocialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );
    setProfileServiceForTesting(
      new ProfileService({
        repository: mockProfileRepo,
        socialRepository: mockSocialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );

    const authHeaders = {
      origin,
      'sec-fetch-site': 'same-origin',
      cookie: `tomato_at=synthetic-at; tomato_csrf=${TEST_CSRF}`,
      [CSRF_HEADER_NAME]: TEST_CSRF,
    };

    // 1. User C (bị A chặn): xem profile A -> 404, follow A -> 404, xem followers/following A -> 404, block ngược A -> 404.
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(makePrincipal(userC)),
    } as unknown as SessionService);

    const cProfileRes = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, { headers: authHeaders }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(cProfileRes.status).toBe(404);
    const cProfileBody = (await cProfileRes.json()) as { error: { code: string; message: string } };

    const cFollowersRes = await followersListGet(
      new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`, {
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(cFollowersRes.status).toBe(404);

    const cFollowRes = await followPost(
      new Request(`${origin}/api/v1/social/follow/${userA.publicId}`, {
        method: 'POST',
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(cFollowRes.status).toBe(404);

    const cBlockBackRes = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${userA.publicId}`, {
        method: 'POST',
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(cBlockBackRes.status).toBe(404);

    // 2. User D (người lạ xem Private User A):
    // - GET /users/:handleA -> 200 khung tối thiểu (canViewConnections: false, followedBy: false dù A mới 'requested' D!).
    // - GET /followers & /following -> 404 ĐỒNG NHẤT hoàn toàn với User C bị chặn!
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(makePrincipal(userD)),
    } as unknown as SessionService);

    const dProfileRes = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, { headers: authHeaders }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(dProfileRes.status).toBe(200);
    const dProfileJson = (await dProfileRes.json()) as {
      profile: Record<string, unknown>;
    };
    expect(dProfileJson.profile.isPrivate).toBe(true);
    expect(dProfileJson.profile.canViewConnections).toBe(false);
    expect(dProfileJson.profile.followedBy).toBe(false);
    expect(dProfileJson.profile).not.toHaveProperty('id');
    expect(dProfileJson.profile).not.toHaveProperty('avatarStorageKey');
    expect(dProfileJson.profile).not.toHaveProperty('email');

    const dFollowersRes = await followersListGet(
      new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`, {
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(dFollowersRes.status).toBe(404);
    const dFollowersBody = (await dFollowersRes.json()) as {
      error: { code: string; message: string };
    };
    // Mã lỗi & thông điệp 404 của User D (Private) giống hệt User C (bị chặn).
    expect(dFollowersBody.error.code).toBe(cProfileBody.error.code);
    expect(dFollowersBody.error.message).toBe(cProfileBody.error.message);

    const dFollowingRes = await followingListGet(
      new Request(`${origin}/api/v1/social/users/${userA.publicId}/following`, {
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(dFollowingRes.status).toBe(404);

    // 3. User B (follower đã được duyệt): được xem profile đầy đủ & danh sách Followers của User A, DTO không lộ trường nội bộ.
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(makePrincipal(userB)),
    } as unknown as SessionService);

    const bProfileRes = await userByHandleGet(
      new Request(`${origin}/api/v1/users/${userA.handle}`, { headers: authHeaders }),
      { params: Promise.resolve({ handle: userA.handle }) },
    );
    expect(bProfileRes.status).toBe(200);
    const bProfileJson = (await bProfileRes.json()) as { profile: Record<string, unknown> };
    expect(bProfileJson.profile.canViewConnections).toBe(true);
    expect(bProfileJson.profile.followStatus).toBe('following');

    const bFollowersRes = await followersListGet(
      new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers`, {
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(bFollowersRes.status).toBe(200);
    const bFollowersJson = (await bFollowersRes.json()) as {
      items: Record<string, unknown>[];
    };
    expect(bFollowersJson.items).toHaveLength(1);
    expect(bFollowersJson.items[0]).not.toHaveProperty('id');
    expect(bFollowersJson.items[0]).not.toHaveProperty('avatarStorageKey');
    expect(bFollowersJson.items[0]).not.toHaveProperty('email');

    // 4. Chống Mass Assignment (BOPLA) trên PATCH /users/me/privacy & query lạ trên /followers.
    const boplaPrivacyRes = await privacyPatch(
      new Request(`${origin}/api/v1/users/me/privacy`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrivate: true, followersCount: 99999 }),
      }),
    );
    expect(boplaPrivacyRes.status).toBe(400);

    const boplaQueryRes = await followersListGet(
      new Request(`${origin}/api/v1/social/users/${userA.publicId}/followers?limit=10&role=admin`, {
        headers: authHeaders,
      }),
      { params: Promise.resolve({ userPublicId: userA.publicId }) },
    );
    expect(boplaQueryRes.status).toBe(400);
  });

  it('bảo vệ tầng SSR /u/[handle]: gọi notFound() khi bị chặn hai chiều (đồng bộ với API 404)', async () => {
    const getRel = buildRelationshipResolver();
    const mockSocialRepo = {
      getRelationshipSnapshot: getRel,
    } as unknown as SocialRepository;
    const mockProfileRepo = {
      findUserByHandleNormalized: vi.fn(async () => userA),
    } as unknown as ProfileRepository;

    setProfileServiceForTesting(
      new ProfileService({
        repository: mockProfileRepo,
        socialRepository: mockSocialRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );

    const principalC = makePrincipal(userC);
    resolveServerAuthStateMock.mockResolvedValue({
      status: 'authenticated',
      principal: principalC,
      user: {
        public_id: userC.publicId,
        username: userC.username,
        fullName: userC.fullName,
        status: userC.status,
      },
      profile: {
        public_id: userC.publicId,
        handle: userC.handle,
        fullName: userC.fullName,
        bio: '',
        avatarUrl: null,
        isPrivate: false,
        followersCount: 0,
        followingCount: 0,
        isOwnProfile: true,
        followStatus: 'none',
        followedBy: false,
        canViewConnections: true,
      },
    });

    await expect(
      UserProfilePage({ params: Promise.resolve({ handle: userA.handle }) }),
    ).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('proxy gắn Cache-Control: no-store cho /api/v1/social/* và bảo vệ /settings/privacy', () => {
    const socialApiReq = new NextRequest('http://localhost:3000/api/v1/social/blocks');
    const socialApiRes = proxy(socialApiReq);
    expect(socialApiRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    const anonPrivacyReq = new NextRequest('http://localhost:3000/settings/privacy');
    const anonPrivacyRes = proxy(anonPrivacyReq);
    expect(anonPrivacyRes.status).toBe(307);
    expect(anonPrivacyRes.headers.get('location')).toBe(
      'http://localhost:3000/login?next=%2Fsettings%2Fprivacy',
    );
  });
});
