import { Writable } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as localAvatarGet } from '@/app/api/v1/media/local/avatars/[fileName]/route';
import { GET as userByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { DELETE as avatarDelete, POST as avatarPost } from '@/app/api/v1/users/me/avatar/route';
import {
  GET as ownProfileGet,
  PATCH as ownProfilePatch,
} from '@/app/api/v1/users/me/profile/route';
import { GET as searchUsersGet } from '@/app/api/v1/users/search/route';
import { getEnv } from '@/core/config/env';
import type { SessionRow, UserRow } from '@/core/db/schema';
import { createLogger } from '@/core/logger';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  resetMediaStorageProviderForTesting,
  setMediaStorageProviderForTesting,
  type MediaStorageProvider,
} from '@/core/storage';
import { sanitizeRedirectPath } from '@/lib/auth-client';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  ProfileService,
  assertCanReadProfile,
  authorizeProfileAction,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
  type ProfileRepository,
} from '@/modules/profile';
import { proxy } from '@/proxy';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}
const TEST_CSRF = 'synthetic-csrf-token-value-for-m6-security-tests';

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-23T09:00:00.000Z');
  return {
    id: '0195a000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_m6',
    handle: 'alice_m6',
    handleNormalized: 'alice_m6',
    fullName: 'Alice Nguyễn',
    bio: 'Xin chào Tomato',
    avatarUrl: null,
    avatarStorageKey: 'avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp',
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 12,
    followingCount: 5,
    handleChangedAt: null,
    gender: 'female',
    dateOfBirth: '1999-01-10',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(userOverrides: Partial<UserRow> = {}): AuthenticatedPrincipal {
  const user = makeUserRow(userOverrides);
  const now = new Date('2026-11-23T09:00:00.000Z');
  const session: SessionRow = {
    id: '0195a000-0000-7000-8000-000000000010',
    publicId: '22222222-2222-4222-8222-222222222222',
    userId: user.id,
    familyId: '33333333-3333-4333-8333-333333333333',
    refreshTokenHash: 'synthetic-hash',
    deviceInfo: 'Chrome on Windows',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
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
      limit: 30,
      remaining: 29,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
    }),
  };
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetProfileServiceForTesting();
  resetMediaStorageProviderForTesting();
  vi.restoreAllMocks();
});

describe('Security M6: Chính sách ReBAC, chống Mass Assignment, CSRF 3 lớp & cô lập tài nguyên', () => {
  it('profile.policy.ts tuân thủ Deny-by-default và trả 404 đồng nhất cho tài khoản không tồn tại/không active', () => {
    const actor = makePrincipal();
    const activeTarget = makeUserRow({
      id: '0195a000-0000-7000-8000-000000000002',
      handle: 'bob_m6',
      handleNormalized: 'bob_m6',
    });

    expect(authorizeProfileAction(actor, 'profile:read', { targetUser: activeTarget })).toBe(true);
    expect(authorizeProfileAction(null, 'profile:read', { targetUser: activeTarget })).toBe(false);

    // Không cho sửa hồ sơ/avatar người khác.
    expect(authorizeProfileAction(actor, 'profile:update', { targetUser: activeTarget })).toBe(
      false,
    );
    expect(authorizeProfileAction(actor, 'avatar:update', { targetUser: activeTarget })).toBe(
      false,
    );
    expect(authorizeProfileAction(actor, 'avatar:delete', { targetUser: activeTarget })).toBe(
      false,
    );

    // Mọi trạng thái không active hoặc null đều bị từ chối với 404 đồng nhất.
    for (const target of [
      null,
      makeUserRow({ status: 'pending_verification' }),
      makeUserRow({ status: 'locked' }),
      makeUserRow({ status: 'suspended' }),
      makeUserRow({ status: 'deleted', deletedAt: new Date() }),
    ]) {
      expect(() => assertCanReadProfile(actor, target)).toThrowError(
        expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
      );
    }
  });

  it('từ chối truy cập ẩn danh (401) trên toàn bộ endpoint hồ sơ & tìm kiếm', async () => {
    const origin = getTestOrigin();
    const searchRes = await searchUsersGet(new Request(`${origin}/api/v1/users/search?q=ab`));
    expect(searchRes.status).toBe(401);
    expect(searchRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    const handleRes = await userByHandleGet(new Request(`${origin}/api/v1/users/alice_m6`), {
      params: Promise.resolve({ handle: 'alice_m6' }),
    });
    expect(handleRes.status).toBe(401);

    const ownRes = await ownProfileGet(new Request(`${origin}/api/v1/users/me/profile`));
    expect(ownRes.status).toBe(401);
  });

  it('cưỡng chế CSRF 3 lớp (Origin + Sec-Fetch-Site + X-CSRF-Token) cho PATCH profile, POST/DELETE avatar', async () => {
    const origin = getTestOrigin();
    // Thiếu Origin -> 403 CSRF_VALIDATION_FAILED
    const patchNoOrigin = await ownProfilePatch(
      new Request(`${origin}/api/v1/users/me/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'New Name' }),
      }),
    );
    expect(patchNoOrigin.status).toBe(403);

    // Sai Origin -> 403
    const postBadOrigin = await avatarPost(
      new Request(`${origin}/api/v1/users/me/avatar`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          cookie: `tomato_csrf=${TEST_CSRF}`,
          [CSRF_HEADER_NAME]: TEST_CSRF,
        },
      }),
    );
    expect(postBadOrigin.status).toBe(403);

    // Thiếu X-CSRF-Token -> 403
    const deleteNoCsrf = await avatarDelete(
      new Request(`${origin}/api/v1/users/me/avatar`, {
        method: 'DELETE',
        headers: {
          origin,
          cookie: `tomato_csrf=${TEST_CSRF}`,
        },
      }),
    );
    expect(deleteNoCsrf.status).toBe(403);
  });

  it('chống Mass Assignment (BOPLA) qua Zod .strict() và đảm bảo DTO không lộ id nội bộ hay avatarStorageKey', async () => {
    const origin = getTestOrigin();
    const actor = makePrincipal();
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(actor),
    } as unknown as SessionService);

    const mockRepo = {
      findUserByHandleNormalized: vi.fn().mockResolvedValue(actor.user),
      searchActiveUsers: vi.fn().mockResolvedValue([
        {
          publicId: actor.user.publicId,
          handle: actor.user.handle,
          fullName: actor.user.fullName,
          avatarUrl: null,
          isPrivate: false,
        },
      ]),
    } as unknown as ProfileRepository;

    setProfileServiceForTesting(
      new ProfileService({
        repository: mockRepo,
        rateLimiter: createAllowAllRateLimiter() as never,
      }),
    );

    // 1. Gửi field lạ (isPrivate / followersCount / role / id) -> 400 VALIDATION_ERROR.
    const boplaRes = await ownProfilePatch(
      new Request(`${origin}/api/v1/users/me/profile`, {
        method: 'PATCH',
        headers: {
          origin,
          'sec-fetch-site': 'same-origin',
          'Content-Type': 'application/json',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${TEST_CSRF}`,
          [CSRF_HEADER_NAME]: TEST_CSRF,
        },
        body: JSON.stringify({
          fullName: 'Alice Updated',
          followersCount: 99999,
          avatarStorageKey: 'avatars/hacked.webp',
        }),
      }),
    );
    expect(boplaRes.status).toBe(400);
    const boplaBody = (await boplaRes.json()) as { error: { code: string } };
    expect(boplaBody.error.code).toBe('VALIDATION_ERROR');

    // 2. DTO phản hồi từ GET /users/:handle tuyệt đối không lộ `id`, `avatarStorageKey`, `dateOfBirth`, `email`.
    const profileRes = await userByHandleGet(
      new Request(`${origin}/api/v1/users/alice_m6`, {
        headers: { cookie: 'tomato_at=synthetic-at' },
      }),
      { params: Promise.resolve({ handle: 'alice_m6' }) },
    );
    expect(profileRes.status).toBe(200);
    expect(profileRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const profileJson = (await profileRes.json()) as { profile: Record<string, unknown> };
    expect(profileJson.profile.public_id).toBe(actor.user.publicId);
    expect(profileJson.profile).not.toHaveProperty('id');
    expect(profileJson.profile).not.toHaveProperty('avatarStorageKey');
    expect(profileJson.profile).not.toHaveProperty('avatar_storage_key');
    expect(profileJson.profile).not.toHaveProperty('dateOfBirth');
    expect(profileJson.profile).not.toHaveProperty('email');

    // 3. DTO phản hồi từ GET /users/search cũng không lộ trường nội bộ.
    const searchRes = await searchUsersGet(
      new Request(`${origin}/api/v1/users/search?q=alice`, {
        headers: { cookie: 'tomato_at=synthetic-at' },
      }),
    );
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { items: Record<string, unknown>[] };
    expect(searchJson.items).toHaveLength(1);
    expect(searchJson.items[0]).not.toHaveProperty('id');
    expect(searchJson.items[0]).not.toHaveProperty('avatarStorageKey');
    expect(searchJson.items[0]).not.toHaveProperty('email');
  });

  it('route đọc ảnh cục bộ chặn Path Traversal và gắn cứng CSP sandbox + nosniff', async () => {
    const origin = getTestOrigin();
    const validFile = '0123456789abcdef0123456789abcdef.webp';
    const mockStorage: MediaStorageProvider = {
      provider: 'local',
      putObject: vi.fn(),
      deleteObject: vi.fn(),
      readObject: vi.fn().mockResolvedValue({
        body: Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary'),
        contentType: 'image/webp',
      }),
    };
    setMediaStorageProviderForTesting(mockStorage);

    const okRes = await localAvatarGet(
      new Request(`${origin}/api/v1/media/local/avatars/${validFile}`),
      { params: Promise.resolve({ fileName: validFile }) },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('Content-Type')).toBe('image/webp');
    expect(okRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(okRes.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");

    for (const badFile of ['../env', 'evil.svg', 'short.webp', '..\\secret.webp']) {
      const blocked = await localAvatarGet(
        new Request(`${origin}/api/v1/media/local/avatars/${encodeURIComponent(badFile)}`),
        { params: Promise.resolve({ fileName: badFile }) },
      );
      expect(blocked.status).toBe(404);
    }
  });

  it('proxy bảo vệ route /u/* chống truy cập ẩn danh và chống Open Redirect qua tham số ?next=', () => {
    const anonProfileReq = new NextRequest('http://localhost:3000/u/alice_m6');
    const anonProfileRes = proxy(anonProfileReq);
    expect(anonProfileRes.status).toBe(307);
    const location = anonProfileRes.headers.get('location');
    expect(location).toBe('http://localhost:3000/login?next=%2Fu%2Falice_m6');

    // Kiểm tra chặt chống Open Redirect cho mọi đầu vào `?next=` độc hại.
    expect(sanitizeRedirectPath('/u/alice_m6')).toBe('/u/alice_m6');
    expect(sanitizeRedirectPath('//evil.com')).toBe('/');
    expect(sanitizeRedirectPath('///evil.com')).toBe('/');
    expect(sanitizeRedirectPath('/\\evil.com')).toBe('/');
    expect(sanitizeRedirectPath('https://evil.com/u/alice')).toBe('/');
    expect(sanitizeRedirectPath('javascript:alert(1)')).toBe('/');
  });

  it('Pino redaction che sạch BLOB_READ_WRITE_TOKEN khỏi log ứng dụng', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    });
    const testLogger = createLogger({ level: 'info', pretty: false, destination: sink });
    const fakeBlobValue = 'synthetic-blob-credential-not-a-real-secret';

    testLogger.info({ BLOB_READ_WRITE_TOKEN: fakeBlobValue, action: 'test' }, 'Storage init');

    const output = chunks.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(fakeBlobValue);
  });
});
