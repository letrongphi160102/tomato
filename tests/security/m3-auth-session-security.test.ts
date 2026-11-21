import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as logoutPost } from '@/app/api/v1/auth/logout/route';
import { POST as refreshPost } from '@/app/api/v1/auth/refresh/route';
import { DELETE as deleteSession } from '@/app/api/v1/auth/sessions/[sessionPublicId]/route';
import { POST as revokeAllPost } from '@/app/api/v1/auth/sessions/revoke-all/route';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { signAccessToken } from '@/core/crypto/jwt';
import { hashPassword } from '@/core/crypto/password';
import { generateSecureToken, hashTokenSha256 } from '@/core/crypto/token';
import type { SessionRow, UserRow } from '@/core/db/schema';
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
      displayName: 'Existing User',
      dateOfBirth: '1998-01-01',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const repository = {
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
    } as unknown as AuthRepository;

    setAuthServiceForTesting(
      new AuthService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
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
      displayName: 'User A',
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

    const mockRevokeById = vi.fn();
    const repository = {
      findSessionWithUserByPublicId: vi.fn(async (sid: string) =>
        sid === sessionA.publicId ? { session: sessionA, user: userA } : null,
      ),
      findSessionByPublicId: vi.fn(async (sid: string) =>
        sid === sessionB.publicId ? sessionB : null,
      ),
      revokeSessionById: mockRevokeById,
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
    expect(mockRevokeById).not.toHaveBeenCalled();
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
});
