import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as loginPost, runtime as loginRuntime } from '@/app/api/v1/auth/login/route';
import { POST as logoutPost, runtime as logoutRuntime } from '@/app/api/v1/auth/logout/route';
import { GET as meGet, runtime as meRuntime } from '@/app/api/v1/auth/me/route';
import { POST as refreshPost, runtime as refreshRuntime } from '@/app/api/v1/auth/refresh/route';
import {
  DELETE as deleteSession,
  runtime as deleteSessionRuntime,
} from '@/app/api/v1/auth/sessions/[sessionPublicId]/route';
import {
  POST as revokeAllPost,
  runtime as revokeAllRuntime,
} from '@/app/api/v1/auth/sessions/revoke-all/route';
import { GET as sessionsGet, runtime as sessionsRuntime } from '@/app/api/v1/auth/sessions/route';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { signAccessToken } from '@/core/crypto/jwt';
import { hashPassword } from '@/core/crypto/password';
import { generateSecureToken, hashTokenSha256 } from '@/core/crypto/token';
import type { SessionRow, UserRow } from '@/core/db/schema';
import type { LoginBruteForceStore } from '@/core/redis/login-brute-force';
import type { RateLimiter } from '@/core/redis/rate-limiter';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AUTH_MESSAGES,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
  type AuthRepository,
} from '@/modules/auth';

const FALLBACK_TEST_ENV: Readonly<Record<string, string>> = {
  APP_URL: 'http://127.0.0.1:3000',
  ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
  DATABASE_URL: 'postgresql://tomato:synthetic@127.0.0.1:5432/tomato_test',
  REDIS_PROVIDER: 'local',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'test-only-synthetic-jwt-secret-value-at-least-32-chars',
  OTP_SECRET: 'test-only-synthetic-otp-secret-value-at-least-32-chars',
  CURRENT_PEPPER_VERSION: '1',
  PASSWORD_PEPPER_SECRETS: '{"1":"test-only-synthetic-pepper-secret-v1-at-least-32-chars"}',
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM: 'Tomato Test <no-reply@tomato.local>',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
};

function makeAllowRateLimiter(): RateLimiter {
  return {
    consume: vi.fn().mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
    }),
  } as unknown as RateLimiter;
}

function makeCleanLoginProtection(): LoginBruteForceStore {
  return {
    checkPair: vi.fn().mockResolvedValue({
      failureCount: 0,
      backoffRemainingMs: 0,
      retryAfterSeconds: 0,
      requireCaptcha: false,
    }),
    recordPairFailure: vi.fn().mockResolvedValue({
      failureCount: 1,
      backoffSeconds: 0,
      requireCaptcha: false,
    }),
    clearPair: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Security M3: Anti-Enumeration Login, CSRF 3 lớp, IDOR 404, Reuse Detection & Rate-Limit-First', () => {
  const injectedEnvKeys: string[] = [];
  let allowedOrigin = 'http://127.0.0.1:3000';

  beforeAll(() => {
    for (const [key, fallbackValue] of Object.entries(FALLBACK_TEST_ENV)) {
      if (!process.env[key]) {
        process.env[key] = fallbackValue;
        injectedEnvKeys.push(key);
      }
    }
    resetEnvCacheForTesting();
    allowedOrigin = getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
  });

  afterAll(() => {
    for (const key of injectedEnvKeys) {
      delete process.env[key];
    }
    resetEnvCacheForTesting();
  });

  afterEach(() => {
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();
  });

  it('Bắt buộc (Anti-Enumeration): Sai email và sai mật khẩu trên /login trả HTTP status, mã lỗi & thông báo giống hệt nhau', async () => {
    const validPassword = 'Cụm mật khẩu hợp lệ cho user active 2026!';
    const hashed = await hashPassword(validPassword);
    const auditRecord = vi.fn().mockResolvedValue({ id: 'audit-1' });

    const existingUser: UserRow = {
      id: '01950000-0000-7000-8000-000000000101',
      publicId: 'e1a5a057-0f04-47b2-95f4-0d6464279b9e',
      username: 'existing_user',
      fullName: 'Existing User',
      gender: 'male',
      dateOfBirth: '1998-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const fakeTx = {};
    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx),
      }),
      findEmailIdentityWithUser: vi.fn(async (email: string) => {
        if (email === 'exists@tomato.test') {
          return {
            user: existingUser,
            identity: {
              id: '01950000-0000-7000-8000-000000000102',
              userId: existingUser.id,
              provider: 'email_password' as const,
              identifierNormalized: 'exists@tomato.test',
              passwordHash: hashed.hash,
              pepperVersion: hashed.pepperVersion,
              verifiedAt: new Date(),
              failedLoginAttempts: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
        return null;
      }),
      incrementFailedLoginAttemptsAndMaybeLock: vi.fn().mockResolvedValue({
        failedLoginAttempts: 1,
        lockedNow: false,
        userStatus: 'active',
      }),
    } as unknown as AuthRepository;

    setAuthServiceForTesting(
      new AuthService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
        loginProtection: makeCleanLoginProtection(),
        auditLogService: { record: auditRecord } as unknown as AuditLogService,
      }),
    );

    const wrongEmailRes = await loginPost(
      new Request(`${allowedOrigin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({
          email: 'does-not-exist@tomato.test',
          password: validPassword,
        }),
      }),
    );

    const wrongPasswordRes = await loginPost(
      new Request(`${allowedOrigin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({
          email: 'exists@tomato.test',
          password: 'Mật khẩu hoàn toàn sai 2026!',
        }),
      }),
    );

    expect(wrongEmailRes.status).toBe(401);
    expect(wrongPasswordRes.status).toBe(401);
    expect(wrongEmailRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(wrongPasswordRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    const wrongEmailJson = await wrongEmailRes.json();
    const wrongPasswordJson = await wrongPasswordRes.json();

    expect(wrongEmailJson).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
        details: [],
      },
    });
    expect(wrongPasswordJson).toEqual(wrongEmailJson);
    expect(wrongEmailRes.headers.getSetCookie()).toHaveLength(0);
    expect(wrongPasswordRes.headers.getSetCookie()).toHaveLength(0);
  });

  it('Bắt buộc (CSRF): Gọi POST /logout, POST /refresh, DELETE /sessions/:id, POST /sessions/revoke-all với Origin lạ hoặc thiếu X-CSRF-Token bị chặn 403', async () => {
    const csrfToken = generateSecureToken();
    const otherCsrfToken = generateSecureToken();

    const mutatingEndpoints: Array<{
      readonly name: string;
      readonly call: (req: Request) => Promise<Response>;
      readonly url: string;
      readonly method: 'POST' | 'DELETE';
    }> = [
      {
        name: 'POST /logout',
        call: (req) => logoutPost(req),
        url: `${allowedOrigin}/api/v1/auth/logout`,
        method: 'POST',
      },
      {
        name: 'POST /refresh',
        call: (req) => refreshPost(req),
        url: `${allowedOrigin}/api/v1/auth/refresh`,
        method: 'POST',
      },
      {
        name: 'DELETE /sessions/:id',
        call: (req) =>
          deleteSession(req, {
            params: Promise.resolve({ sessionPublicId: 'target-session-public-id' }),
          }),
        url: `${allowedOrigin}/api/v1/auth/sessions/target-session-public-id`,
        method: 'DELETE',
      },
      {
        name: 'POST /sessions/revoke-all',
        call: (req) => revokeAllPost(req),
        url: `${allowedOrigin}/api/v1/auth/sessions/revoke-all`,
        method: 'POST',
      },
    ];

    for (const endpoint of mutatingEndpoints) {
      // 1. Origin lạ
      const evilOriginRes = await endpoint.call(
        new Request(endpoint.url, {
          method: endpoint.method,
          headers: {
            Origin: 'https://evil-attacker.invalid',
            'Sec-Fetch-Site': 'same-origin',
            [CSRF_HEADER_NAME]: csrfToken,
            cookie: `tomato_csrf=${csrfToken}`,
          },
        }),
      );
      expect(evilOriginRes.status, `${endpoint.name} evil origin`).toBe(403);
      expect(evilOriginRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
      const evilJson = (await evilOriginRes.json()) as { error: { code: string } };
      expect(evilJson.error.code).toBe('CSRF_VALIDATION_FAILED');

      // 2. Thiếu X-CSRF-Token
      const missingCsrfRes = await endpoint.call(
        new Request(endpoint.url, {
          method: endpoint.method,
          headers: {
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'same-origin',
            cookie: `tomato_csrf=${csrfToken}`,
          },
        }),
      );
      expect(missingCsrfRes.status, `${endpoint.name} missing csrf`).toBe(403);
      const missingJson = (await missingCsrfRes.json()) as { error: { code: string } };
      expect(missingJson.error.code).toBe('CSRF_VALIDATION_FAILED');

      // 3. Sai X-CSRF-Token (không khớp cookie)
      const mismatchCsrfRes = await endpoint.call(
        new Request(endpoint.url, {
          method: endpoint.method,
          headers: {
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'same-origin',
            [CSRF_HEADER_NAME]: otherCsrfToken,
            cookie: `tomato_csrf=${csrfToken}`,
          },
        }),
      );
      expect(mismatchCsrfRes.status, `${endpoint.name} mismatch csrf`).toBe(403);

      // 4. Cross-site Fetch Metadata
      const crossSiteRes = await endpoint.call(
        new Request(endpoint.url, {
          method: endpoint.method,
          headers: {
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'cross-site',
            [CSRF_HEADER_NAME]: csrfToken,
            cookie: `tomato_csrf=${csrfToken}`,
          },
        }),
      );
      expect(crossSiteRes.status, `${endpoint.name} cross-site`).toBe(403);
    }
  });

  it('Bắt buộc (IDOR): User A gọi DELETE phiên của User B nhận 404 NOT_FOUND và không gọi revokeSessionById', async () => {
    const userA: UserRow = {
      id: '01950000-0000-7000-8000-000000000201',
      publicId: 'user-a-public-id',
      username: 'user_a_idor',
      fullName: 'User A',
      gender: 'female',
      dateOfBirth: '1998-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const sessionA: SessionRow = {
      id: '01950000-0000-7000-8000-000000000210',
      publicId: 'session-a-public-id',
      userId: userA.id,
      familyId: 'family-a',
      refreshTokenHash: 'a'.repeat(64),
      deviceInfo: 'Chrome 130 / Windows 10/11',
      ipAddress: '198.51.100.10',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(),
    };
    const sessionB: SessionRow = {
      ...sessionA,
      id: '01950000-0000-7000-8000-000000000220',
      publicId: 'session-b-public-id',
      userId: '01950000-0000-7000-8000-000000000202',
      familyId: 'family-b',
      refreshTokenHash: 'b'.repeat(64),
    };

    const mockRevokeFamily = vi.fn();
    const mockFindForUser = vi.fn(async (sid: string, userId: string) =>
      sid === sessionB.publicId && userId === sessionB.userId ? sessionB : null,
    );
    const repository = {
      findSessionWithUserByPublicId: vi.fn(async (sid: string) =>
        sid === sessionA.publicId ? { session: sessionA, user: userA } : null,
      ),
      findSessionByPublicIdForUser: mockFindForUser,
      revokeSessionFamily: mockRevokeFamily,
    } as unknown as AuthRepository;

    setSessionServiceForTesting(
      new SessionService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      }),
    );

    const accessTokenA = await signAccessToken({
      userPublicId: userA.publicId,
      sessionPublicId: sessionA.publicId,
    });
    const csrfToken = generateSecureToken();

    const response = await deleteSession(
      new Request(`${allowedOrigin}/api/v1/auth/sessions/${sessionB.publicId}`, {
        method: 'DELETE',
        headers: {
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          [CSRF_HEADER_NAME]: csrfToken,
          cookie: `tomato_at=${accessTokenA}; tomato_csrf=${csrfToken}`,
        },
      }),
      { params: Promise.resolve({ sessionPublicId: sessionB.publicId }) },
    );

    expect(response.status).toBe(404);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_FOUND');
    expect(mockFindForUser).toHaveBeenCalledWith(sessionB.publicId, userA.id);
    expect(mockRevokeFamily).not.toHaveBeenCalled();
  });

  it('Bắt buộc (Reuse Detection): Dùng lại RT1 đã xoay vòng thu hồi toàn bộ family_id, ghi TOKEN_REUSE_DETECTED, xóa cookie và trả 401', async () => {
    const rt1 = generateSecureToken(32);
    const rt1Hash = hashTokenSha256(rt1);
    const rotatedRow: SessionRow = {
      id: '01950000-0000-7000-8000-000000000301',
      publicId: 'session-rt1-public',
      userId: '01950000-0000-7000-8000-000000000300',
      familyId: 'family-compromised-1',
      refreshTokenHash: rt1Hash,
      deviceInfo: 'Chrome 130 / Windows 10/11',
      ipAddress: '198.51.100.30',
      lastUsedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(Date.now() - 30_000),
      revokeReason: 'token_rotated',
      createdAt: new Date(Date.now() - 120_000),
    };

    const mockRevokeFamily = vi.fn().mockResolvedValue(['session-rt2-id']);
    const mockAuditRecord = vi.fn().mockResolvedValue({ id: 'audit-reuse-1' });
    const fakeTx = {};
    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx),
      }),
      lockSessionByRefreshTokenHash: vi.fn(async (hash: string) =>
        hash === rt1Hash ? rotatedRow : null,
      ),
      revokeSessionFamily: mockRevokeFamily,
    } as unknown as AuthRepository;

    setSessionServiceForTesting(
      new SessionService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
        auditLogService: { record: mockAuditRecord } as unknown as AuditLogService,
      }),
    );

    const csrfToken = generateSecureToken();
    const res = await refreshPost(
      new Request(`${allowedOrigin}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          [CSRF_HEADER_NAME]: csrfToken,
          cookie: `tomato_rt=${rt1}; tomato_csrf=${csrfToken}`,
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('tomato_at=') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect(setCookies.some((c) => c.startsWith('tomato_rt=') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect(setCookies.some((c) => c.startsWith('tomato_csrf=') && c.includes('Max-Age=0'))).toBe(
      true,
    );

    expect(mockRevokeFamily).toHaveBeenCalledWith(
      'family-compromised-1',
      rotatedRow.userId,
      expect.any(Date),
      'token_reuse',
      fakeTx,
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: rotatedRow.userId,
        action: 'TOKEN_REUSE_DETECTED',
        metadata: expect.objectContaining({
          familyId: 'family-compromised-1',
          reusedSessionPublicId: 'session-rt1-public',
        }),
      }),
      fakeTx,
    );
  });

  it('Rate Limit trên /login chạy TRƯỚC khi truy vấn DB hoặc băm Argon2id và trả 429 + Retry-After', async () => {
    const mockFindIdentity = vi.fn();
    setAuthServiceForTesting(
      new AuthService({
        repository: { findEmailIdentityWithUser: mockFindIdentity } as unknown as AuthRepository,
        rateLimiter: {
          consume: vi.fn().mockResolvedValue({
            allowed: false,
            limit: 10,
            remaining: 0,
            resetAt: Date.now() + 90_000,
            retryAfterSeconds: 90,
          }),
        } as unknown as RateLimiter,
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      }),
    );

    const res = await loginPost(
      new Request(`${allowedOrigin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          'x-forwarded-for': '198.51.100.88',
        },
        body: JSON.stringify({
          email: 'user@tomato.test',
          password: 'any-password',
        }),
      }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('90');
    expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(mockFindIdentity).not.toHaveBeenCalled();
  });

  it('Audit Q1 & Q4: Toàn bộ Auth routes khai báo runtime="nodejs" và KHÔNG bao giờ lộ users.id / sessions.id (UUIDv7) ra JSON, Cookie hay JWT', async () => {
    expect(loginRuntime).toBe('nodejs');
    expect(logoutRuntime).toBe('nodejs');
    expect(meRuntime).toBe('nodejs');
    expect(refreshRuntime).toBe('nodejs');
    expect(sessionsRuntime).toBe('nodejs');
    expect(deleteSessionRuntime).toBe('nodejs');
    expect(revokeAllRuntime).toBe('nodejs');

    const internalUserId = '01950000-0000-7000-8000-000000000777';
    const internalSessionId = '01950000-0000-7000-8000-000000000888';
    const publicUserId = 'f29e0411-4090-4a1c-a40a-3a951a9cf777';
    const publicSessionId = 'e71a2b3c-4d5e-4f60-9a1b-2c3d4e5f6888';
    const validPassword = 'Cụm mật khẩu kiểm thử không lộ UUIDv7 2026!';
    const hashed = await hashPassword(validPassword);

    const userRow: UserRow = {
      id: internalUserId,
      publicId: publicUserId,
      username: 'audit_user_777',
      fullName: 'Audit User',
      gender: 'other',
      dateOfBirth: '1999-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const sessionRow: SessionRow = {
      id: internalSessionId,
      publicId: publicSessionId,
      userId: internalUserId,
      familyId: 'c1234567-89ab-4cde-9012-3456789abcde',
      refreshTokenHash: 'f'.repeat(64),
      deviceInfo: 'Chrome 130 / Windows 10/11',
      ipAddress: '198.51.100.99',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(),
    };

    const fakeTx = {};
    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx),
      }),
      findEmailIdentityWithUser: vi.fn().mockResolvedValue({
        user: userRow,
        identity: {
          id: '01950000-0000-7000-8000-000000000778',
          userId: internalUserId,
          provider: 'email_password' as const,
          identifierNormalized: 'audit-uuid@tomato.test',
          passwordHash: hashed.hash,
          pepperVersion: hashed.pepperVersion,
          verifiedAt: new Date(),
          failedLoginAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      lockUserById: vi.fn().mockResolvedValue(userRow),
      resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(sessionRow),
      findSessionWithUserByPublicId: vi
        .fn()
        .mockResolvedValue({ session: sessionRow, user: userRow }),
      listActiveSessionsByUserId: vi.fn().mockResolvedValue([sessionRow]),
    } as unknown as AuthRepository;

    const sessionService = new SessionService({
      repository,
      rateLimiter: makeAllowRateLimiter(),
      auditLogService: {
        record: vi.fn().mockResolvedValue({ id: 'a1' }),
      } as unknown as AuditLogService,
    });
    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter: makeAllowRateLimiter(),
      loginProtection: makeCleanLoginProtection(),
      auditLogService: {
        record: vi.fn().mockResolvedValue({ id: 'a2' }),
      } as unknown as AuditLogService,
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);

    const loginRes = await loginPost(
      new Request(`${allowedOrigin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({
          email: 'audit-uuid@tomato.test',
          password: validPassword,
        }),
      }),
    );

    expect(loginRes.status).toBe(200);
    const loginText = await loginRes.text();
    expect(loginText).not.toContain(internalUserId);
    expect(loginText).not.toContain(internalSessionId);

    const atCookie = loginRes.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('tomato_at='));
    expect(atCookie).toBeDefined();
    const rawJwt = atCookie!.split(';')[0]!.split('=')[1]!;
    const claims = decodeJwt(rawJwt);
    expect(claims.sub).toBe(publicUserId);
    expect(claims.sid).toBe(publicSessionId);
    expect(JSON.stringify(claims)).not.toContain(internalUserId);
    expect(JSON.stringify(claims)).not.toContain(internalSessionId);

    const meRes = await meGet(
      new Request(`${allowedOrigin}/api/v1/auth/me`, {
        method: 'GET',
        headers: { cookie: `tomato_at=${rawJwt}` },
      }),
    );
    expect(meRes.status).toBe(200);
    const meText = await meRes.text();
    expect(meText).not.toContain(internalUserId);
    expect(meText).not.toContain(internalSessionId);

    const sessionsRes = await sessionsGet(
      new Request(`${allowedOrigin}/api/v1/auth/sessions`, {
        method: 'GET',
        headers: { cookie: `tomato_at=${rawJwt}` },
      }),
    );
    expect(sessionsRes.status).toBe(200);
    const sessionsText = await sessionsRes.text();
    expect(sessionsText).not.toContain(internalUserId);
    expect(sessionsText).not.toContain(internalSessionId);
  });

  it('Audit Q3 (TOCTOU Login): Nếu tài khoản bị chuyển sang suspended trong lúc Argon2id đang chạy -> không tạo phiên và trả 403 ACCOUNT_SUSPENDED', async () => {
    const validPassword = 'Cụm mật khẩu kiểm thử TOCTOU login 2026!';
    const hashed = await hashPassword(validPassword);

    const activeUserSnapshot: UserRow = {
      id: '01950000-0000-7000-8000-000000000801',
      publicId: 'e1a5a057-0f04-47b2-95f4-0d6464279801',
      username: 'midflight_user',
      fullName: 'User Suspended Mid-Flight',
      gender: 'male',
      dateOfBirth: '1998-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const createSessionSpy = vi.fn();
    const fakeTx = {};
    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx),
      }),
      findEmailIdentityWithUser: vi.fn().mockResolvedValue({
        user: activeUserSnapshot,
        identity: {
          id: '01950000-0000-7000-8000-000000000802',
          userId: activeUserSnapshot.id,
          provider: 'email_password' as const,
          identifierNormalized: 'midflight@tomato.test',
          passwordHash: hashed.hash,
          pepperVersion: hashed.pepperVersion,
          verifiedAt: new Date(),
          failedLoginAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      // Trong transaction, đọc lại dòng user thấy đã chuyển sang `suspended`.
      lockUserById: vi.fn().mockResolvedValue({ ...activeUserSnapshot, status: 'suspended' }),
      createSession: createSessionSpy,
    } as unknown as AuthRepository;

    setAuthServiceForTesting(
      new AuthService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
        loginProtection: makeCleanLoginProtection(),
        auditLogService: {
          record: vi.fn().mockResolvedValue({ id: 'a3' }),
        } as unknown as AuditLogService,
      }),
    );

    const res = await loginPost(
      new Request(`${allowedOrigin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({
          email: 'midflight@tomato.test',
          password: validPassword,
        }),
      }),
    );

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('Audit Q3 (TOCTOU Session Revocation & Concurrent Refresh Logout): chặn phiên đã bị thu hồi song song khi gọi revokeSession/revokeAllSessions và vẫn thu hồi family_id khi logout ngay sau khi RT vừa xoay vòng', async () => {
    const userRow: UserRow = {
      id: '01950000-0000-7000-8000-000000000951',
      publicId: 'f29e0411-4090-4a1c-a40a-3a951a9cf951',
      username: 'toctou_session_user',
      fullName: 'TOCTOU User',
      gender: 'other',
      dateOfBirth: '1999-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const currentSession: SessionRow = {
      id: '01950000-0000-7000-8000-000000000952',
      publicId: 'session-curr-952',
      userId: userRow.id,
      familyId: 'family-curr-952',
      refreshTokenHash: 'c'.repeat(64),
      deviceInfo: 'Chrome 130 / Windows 10/11',
      ipAddress: '198.51.100.51',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(),
    };
    const otherSession: SessionRow = {
      ...currentSession,
      id: '01950000-0000-7000-8000-000000000953',
      publicId: 'session-other-953',
      familyId: 'family-other-953',
      refreshTokenHash: 'd'.repeat(64),
    };

    const revokeFamilySpy = vi.fn();
    const revokeAllSpy = vi.fn();

    // Giả lập phiên gọi `currentSession` vừa bị thu hồi song song ngay trước khi bước vào transaction.
    const toctouRepo = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
      }),
      lockUserById: vi.fn().mockResolvedValue(userRow),
      acquireSessionFamilyLock: vi.fn().mockResolvedValue(undefined),
      findSessionByPublicIdForUser: vi.fn(async (sid: string, _uid: string, tx?: unknown) => {
        if (!tx && sid === otherSession.publicId) {
          return otherSession;
        }
        if (tx && sid === currentSession.publicId) {
          return { ...currentSession, revokedAt: new Date(), revokeReason: 'revoke_all_sessions' };
        }
        return otherSession;
      }),
      revokeSessionFamily: revokeFamilySpy,
      revokeAllUserSessions: revokeAllSpy,
    } as unknown as AuthRepository;

    const sessionSvc = new SessionService({
      repository: toctouRepo,
      rateLimiter: makeAllowRateLimiter(),
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
    });
    const ctx = {
      ipAddress: '198.51.100.51',
      rateLimitIpKey: '198.51.100.51',
      userAgent: 'Vitest',
    };

    await expect(
      sessionSvc.revokeSession(
        { user: userRow, session: currentSession },
        otherSession.publicId,
        ctx,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(revokeFamilySpy).not.toHaveBeenCalled();

    await expect(
      sessionSvc.revokeAllSessions(
        { user: userRow, session: currentSession },
        { includeCurrent: false },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(revokeAllSpy).not.toHaveBeenCalled();

    // Trường hợp `/logout` mang AT/RT cũ vừa bị Silent Refresh xoay vòng (`token_rotated`) -> vẫn phải thu hồi family_id!
    const rotatedRow: SessionRow = {
      ...currentSession,
      revokedAt: new Date(Date.now() - 500),
      revokeReason: 'token_rotated',
    };
    const logoutRevokeFamilySpy = vi.fn().mockResolvedValue(['new-rotated-session-id']);
    const logoutSvc = new SessionService({
      repository: {
        getDb: () => ({
          transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
        }),
        findSessionByRefreshTokenHash: vi.fn().mockResolvedValue(rotatedRow),
        lockUserById: vi.fn().mockResolvedValue(userRow),
        acquireSessionFamilyLock: vi.fn().mockResolvedValue(undefined),
        revokeSessionFamily: logoutRevokeFamilySpy,
      } as unknown as AuthRepository,
      rateLimiter: makeAllowRateLimiter(),
      auditLogService: {
        record: vi.fn().mockResolvedValue({ id: 'a-rot' }),
      } as unknown as AuditLogService,
    });

    const logoutRes = await logoutSvc.logoutCurrentSession(
      { accessToken: null, refreshToken: generateSecureToken(32) },
      ctx,
    );
    expect(logoutRes.loggedOut).toBe(true);
    expect(logoutRevokeFamilySpy).toHaveBeenCalledWith(
      rotatedRow.familyId,
      rotatedRow.userId,
      expect.any(Date),
      'user_logout',
      expect.anything(),
    );
  });
});
