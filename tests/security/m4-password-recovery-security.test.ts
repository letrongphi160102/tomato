import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { metadata as resetPageMetadata } from '@/app/(auth)/reset-password/page';
import {
  POST as changePasswordOtpPost,
  runtime as changePasswordOtpRuntime,
} from '@/app/api/v1/auth/change-password/request-otp/route';
import {
  POST as changePasswordPost,
  runtime as changePasswordRuntime,
} from '@/app/api/v1/auth/change-password/route';
import {
  POST as verifyChangePasswordOtpPost,
  runtime as verifyChangePasswordOtpRuntime,
} from '@/app/api/v1/auth/change-password/verify-otp/route';
import {
  POST as forgotPasswordPost,
  runtime as forgotPasswordRuntime,
} from '@/app/api/v1/auth/forgot-password/route';
import {
  POST as resetPasswordPost,
  runtime as resetPasswordRuntime,
} from '@/app/api/v1/auth/reset-password/route';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { hashOtpCode } from '@/core/crypto/otp';
import { hashPassword } from '@/core/crypto/password';
import { generateSecureToken, hashScopedTokenSha256, hashTokenSha256 } from '@/core/crypto/token';
import type { SessionRow, UserRow, VerificationTokenRow } from '@/core/db/schema';
import { EmailDeliveryError, type EmailProvider } from '@/core/email';
import type { RateLimiter } from '@/core/redis/rate-limiter';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AuthDomainError,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
  type AuthRepository,
  type AuthenticatedPrincipal,
} from '@/modules/auth';
import { proxy } from '@/proxy';

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

function makeDenyRateLimiter(retryAfterSeconds = 42): RateLimiter {
  return {
    consume: vi.fn().mockResolvedValue({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: Date.now() + retryAfterSeconds * 1000,
      retryAfterSeconds,
    }),
  } as unknown as RateLimiter;
}

function makeActivePrincipal(overrides: Partial<UserRow> = {}): AuthenticatedPrincipal {
  const user: UserRow = {
    id: '01950000-0000-7000-8000-000000004001',
    publicId: '8a6f2d8b-c71b-4239-898a-b88f9f03c401',
    username: 'm4_sec_user',
    fullName: 'Nguyen Bao Mat',
    gender: 'male',
    dateOfBirth: '1999-05-05',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
  const session: SessionRow = {
    id: '01950000-0000-7000-8000-000000004010',
    publicId: 'session-public-m4-sec-1',
    userId: user.id,
    familyId: 'family-m4-sec-1',
    refreshTokenHash: 'b'.repeat(64),
    deviceInfo: 'Chrome 130 / Windows 10/11',
    ipAddress: '203.0.113.10',
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokeReason: null,
    createdAt: new Date(),
  };
  return { user, session };
}

describe('Security M4: CSRF 3 lớp, Rate-Limit-First, Referrer Protection, Token Domain Separation & Fail-Safe Alerting', () => {
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

  it('khai báo runtime="nodejs" trên toàn bộ 5 API routes khôi phục/đổi mật khẩu và bảo vệ trang /reset-password bằng Referrer-Policy: no-referrer', () => {
    expect(forgotPasswordRuntime).toBe('nodejs');
    expect(resetPasswordRuntime).toBe('nodejs');
    expect(changePasswordOtpRuntime).toBe('nodejs');
    expect(verifyChangePasswordOtpRuntime).toBe('nodejs');
    expect(changePasswordRuntime).toBe('nodejs');

    expect(resetPageMetadata.referrer).toBe('no-referrer');

    const resetPageRes = proxy(
      new NextRequest(`${allowedOrigin}/reset-password?token=${generateSecureToken(32)}`),
    );
    expect(resetPageRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(resetPageRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(resetPageRes.headers.get('Pragma')).toBe('no-cache');
  });

  it('chặn 403 CSRF_VALIDATION_FAILED trên /forgot-password và /reset-password khi thiếu/sai Origin hoặc cross-site', async () => {
    const publicEndpoints = [
      { url: `${allowedOrigin}/api/v1/auth/forgot-password`, handler: forgotPasswordPost },
      { url: `${allowedOrigin}/api/v1/auth/reset-password`, handler: resetPasswordPost },
    ];

    for (const { url, handler } of publicEndpoints) {
      const missingOrigin = await handler(
        new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(missingOrigin.status).toBe(403);
      expect(missingOrigin.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
      expect(((await missingOrigin.json()) as { error: { code: string } }).error.code).toBe(
        'CSRF_VALIDATION_FAILED',
      );

      const evilOrigin = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil-attacker.invalid',
            'Sec-Fetch-Site': 'same-origin',
          },
          body: JSON.stringify({}),
        }),
      );
      expect(evilOrigin.status).toBe(403);

      const crossSite = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify({}),
        }),
      );
      expect(crossSite.status).toBe(403);
    }
  });

  it('bắt buộc Double-Submit X-CSRF-Token trên /change-password/request-otp và /change-password (403 khi thiếu hoặc lệch)', async () => {
    const csrfToken = generateSecureToken(32);
    const otherCsrfToken = generateSecureToken(32);

    const protectedEndpoints = [
      {
        url: `${allowedOrigin}/api/v1/auth/change-password/request-otp`,
        handler: changePasswordOtpPost,
      },
      {
        url: `${allowedOrigin}/api/v1/auth/change-password/verify-otp`,
        handler: verifyChangePasswordOtpPost,
      },
      { url: `${allowedOrigin}/api/v1/auth/change-password`, handler: changePasswordPost },
    ];

    for (const { url, handler } of protectedEndpoints) {
      const noHeaderRes = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'same-origin',
            cookie: `tomato_csrf=${csrfToken}`,
          },
          body: JSON.stringify({}),
        }),
      );
      expect(noHeaderRes.status).toBe(403);
      expect(noHeaderRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

      const mismatchRes = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: allowedOrigin,
            'Sec-Fetch-Site': 'same-origin',
            cookie: `tomato_csrf=${csrfToken}`,
            [CSRF_HEADER_NAME]: otherCsrfToken,
          },
          body: JSON.stringify({}),
        }),
      );
      expect(mismatchRes.status).toBe(403);
    }
  });

  it('Rate Limit chạy TRƯỚC Zod, truy vấn DB và Argon2id trên cả 4 endpoint M4', async () => {
    const principal = makeActivePrincipal();
    const csrfToken = generateSecureToken(32);
    const findIdentitySpy = vi.fn();
    const findTokenSpy = vi.fn();
    const findIdentityByUserSpy = vi.fn();

    const authService = new AuthService({
      rateLimiter: makeDenyRateLimiter(55),
      repository: {
        findEmailIdentityWithUser: findIdentitySpy,
        findVerificationTokenByHash: findTokenSpy,
        findEmailIdentityByUserId: findIdentityByUserSpy,
      } as unknown as AuthRepository,
      emailProvider: { provider: 'memory', send: vi.fn() },
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });
    const sessionService = {
      authenticateAccessToken: vi.fn().mockResolvedValue(principal),
    } as unknown as SessionService;

    setAuthServiceForTesting(authService);
    setSessionServiceForTesting(sessionService);

    const forgotRes = await forgotPasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          'x-forwarded-for': '203.0.113.201',
        },
        body: JSON.stringify({ email: 'bad-email' }),
      }),
    );
    expect(forgotRes.status).toBe(429);
    expect(forgotRes.headers.get('Retry-After')).toBe('55');

    const resetRes = await resetPasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          'x-forwarded-for': '203.0.113.202',
        },
        body: JSON.stringify({ token: 'short', newPassword: 'short' }),
      }),
    );
    expect(resetRes.status).toBe(429);
    expect(resetRes.headers.get('Retry-After')).toBe('55');

    const reqOtpRes = await changePasswordOtpPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password/request-otp`, {
        method: 'POST',
        headers: {
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=dummy-at; tomato_csrf=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
          'x-forwarded-for': '203.0.113.203',
        },
      }),
    );
    expect(reqOtpRes.status).toBe(429);
    expect(reqOtpRes.headers.get('Retry-After')).toBe('55');

    const verifyOtpRes = await verifyChangePasswordOtpPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=dummy-at; tomato_csrf=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
          'x-forwarded-for': '203.0.113.205',
        },
        body: JSON.stringify({ otpCode: '000000' }),
      }),
    );
    expect(verifyOtpRes.status).toBe(429);
    expect(verifyOtpRes.headers.get('Retry-After')).toBe('55');

    const changeRes = await changePasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=dummy-at; tomato_csrf=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
          'x-forwarded-for': '203.0.113.204',
        },
        body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
      }),
    );
    expect(changeRes.status).toBe(429);
    expect(changeRes.headers.get('Retry-After')).toBe('55');

    expect(findIdentitySpy).not.toHaveBeenCalled();
    expect(findTokenSpy).not.toHaveBeenCalled();
    expect(findIdentityByUserSpy).not.toHaveBeenCalled();
  });

  it('tài khoản suspended hoặc deleted tuyệt đối không thể tự mở khóa bằng token reset cũ', async () => {
    const rawToken = generateSecureToken(32);
    const tokenHash = hashTokenSha256(rawToken);
    const tokenRow: VerificationTokenRow = {
      id: '01950000-0000-7000-8000-000000004099',
      userId: '01950000-0000-7000-8000-000000004001',
      purpose: 'password_reset',
      tokenHash,
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: null,
      createdAt: new Date(),
    };

    for (const blockedStatus of ['suspended', 'deleted', 'pending_verification'] as const) {
      const txSpy = vi.fn();
      const service = new AuthService({
        rateLimiter: makeAllowRateLimiter(),
        repository: {
          getDb: () => ({ transaction: txSpy }),
          findVerificationTokenByHash: vi.fn().mockResolvedValue(tokenRow),
          findUserById: vi.fn().mockResolvedValue({
            ...makeActivePrincipal().user,
            status: blockedStatus,
          }),
          findEmailIdentityByUserId: vi.fn().mockResolvedValue({
            id: '01950000-0000-7000-8000-000000004002',
            userId: tokenRow.userId,
            provider: 'email_password',
            identifierNormalized: 'blocked@tomato.test',
            passwordHash: 'hash',
            pepperVersion: 1,
            verifiedAt: new Date(),
            failedLoginAttempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        } as unknown as AuthRepository,
        emailProvider: { provider: 'memory', send: vi.fn() },
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
        appUrl: allowedOrigin,
      });

      await expect(
        service.resetPassword(
          { token: rawToken, newPassword: 'completely safe reset passphrase 2026' },
          { ipAddress: '203.0.113.50', rateLimitIpKey: '203.0.113.50', userAgent: 'Vitest' },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof AuthDomainError && err.status === 400 && err.code === 'TOKEN_INVALID',
      );
      expect(txSpy).not.toHaveBeenCalled();
    }
  });

  it('tách miền OTP (Domain Separation): mã OTP sinh cho email_verify không khớp password_change ở Bước 1b, và Bước 2 chặn nhảy cóc khi thiếu ticket', async () => {
    const principal = makeActivePrincipal();
    const currentPassword = 'current strong passphrase 2026!';
    const hashed = await hashPassword(currentPassword);
    const otpCode = '739204';
    // Cố tình gán hash sinh theo miền `email_verify` thay vì `password_change`.
    const wrongDomainOtpHash = hashOtpCode(otpCode, {
      userId: principal.user.id,
      purpose: 'email_verify',
    });

    const updateAttemptSpy = vi.fn().mockResolvedValue(undefined);
    const txSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));

    const service = new AuthService({
      rateLimiter: makeAllowRateLimiter(),
      loginProtection: {
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
      },
      repository: {
        getDb: () => ({ transaction: txSpy }),
        findEmailIdentityByUserId: vi.fn().mockResolvedValue({
          id: '01950000-0000-7000-8000-000000004002',
          userId: principal.user.id,
          provider: 'email_password',
          identifierNormalized: 'm4sec@tomato.test',
          passwordHash: hashed.hash,
          pepperVersion: hashed.pepperVersion,
          verifiedAt: new Date(),
          failedLoginAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        lockUserById: vi.fn().mockResolvedValue(principal.user),
        findSessionByPublicIdForUser: vi.fn().mockResolvedValue(principal.session),
        acquireSessionFamilyLock: vi.fn().mockResolvedValue(undefined),
        lockLatestUnconsumedTokenByPurpose: vi.fn().mockResolvedValue({
          id: '01950000-0000-7000-8000-000000004055',
          userId: principal.user.id,
          purpose: 'password_change',
          tokenHash: wrongDomainOtpHash,
          attemptCount: 0,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          consumedAt: null,
          createdAt: new Date(),
        }),
        updateVerificationTokenAttempt: updateAttemptSpy,
      } as unknown as AuthRepository,
      emailProvider: { provider: 'memory', send: vi.fn() },
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    const ctx = {
      ipAddress: '203.0.113.60',
      rateLimitIpKey: '203.0.113.60',
      userAgent: 'Vitest',
    };

    // 1. Nhảy thẳng vào Bước 2 khi chưa có ticket Bước 1 -> trả 403 TOKEN_INVALID ngay trước khi mở transaction hay Argon2id.
    await expect(
      service.changePassword(
        principal,
        {
          currentPassword: 'wrong current passphrase 2026!',
          newPassword: 'brand new safe passphrase 2027!',
        },
        null,
        ctx,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthDomainError &&
        err.status === 403 &&
        err.code === 'TOKEN_INVALID' &&
        err.clearPasswordChangeTicket === true,
    );
    expect(txSpy).not.toHaveBeenCalled();

    // 2. Bước 1b: hash lưu trong DB thuộc miền `email_verify` -> bị từ chối 400 TOKEN_INVALID và tăng attemptCount.
    await expect(service.verifyPasswordChangeOtp(principal, { otpCode }, ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthDomainError && err.status === 400 && err.code === 'TOKEN_INVALID',
    );
    expect(updateAttemptSpy).toHaveBeenCalledWith(
      '01950000-0000-7000-8000-000000004055',
      principal.user.id,
      1,
      null,
      expect.anything(),
    );
  });

  it('lỗi SMTP khi gửi email cảnh báo sau khi đặt lại mật khẩu thành công KHÔNG làm hỏng phản hồi 200', async () => {
    const principal = makeActivePrincipal();
    const rawToken = generateSecureToken(32);
    const tokenHash = hashTokenSha256(rawToken);
    const tokenRow: VerificationTokenRow = {
      id: '01950000-0000-7000-8000-000000004123',
      userId: principal.user.id,
      purpose: 'password_reset',
      tokenHash,
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: null,
      createdAt: new Date(),
    };
    const identityRow = {
      id: '01950000-0000-7000-8000-000000004124',
      userId: principal.user.id,
      provider: 'email_password' as const,
      identifierNormalized: 'smtp-fail-alert@tomato.test',
      passwordHash: 'old-hash',
      pepperVersion: 1,
      verifiedAt: new Date(),
      failedLoginAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const failingEmailProvider: EmailProvider = {
      provider: 'smtp',
      send: vi.fn().mockRejectedValue(new EmailDeliveryError('smtp', 'SMTP temporarily down')),
    };

    const service = new AuthService({
      rateLimiter: makeAllowRateLimiter(),
      loginProtection: {
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
      },
      repository: {
        getDb: () => ({
          transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
        }),
        findVerificationTokenByHash: vi.fn().mockResolvedValue(tokenRow),
        findUserById: vi.fn().mockResolvedValue(principal.user),
        findEmailIdentityByUserId: vi.fn().mockResolvedValue(identityRow),
        lockUserById: vi.fn().mockResolvedValue(principal.user),
        lockVerificationTokenById: vi.fn().mockResolvedValue(tokenRow),
        updateIdentityPasswordHash: vi.fn().mockResolvedValue(true),
        resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
        consumeAllUnconsumedTokensByPurpose: vi.fn().mockResolvedValue(undefined),
        revokeAllUserSessions: vi.fn().mockResolvedValue(2),
      } as unknown as AuthRepository,
      emailProvider: failingEmailProvider,
      auditLogService: {
        record: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    const result = await service.resetPassword(
      { token: rawToken, newPassword: 'fresh strong passphrase 2027!' },
      { ipAddress: '203.0.113.70', rateLimitIpKey: '203.0.113.70', userAgent: 'Chrome/130' },
    );

    expect(result.reset).toBe(true);
    expect(failingEmailProvider.send).toHaveBeenCalledTimes(1);
  });

  it('Security Audit Hardening: changePassword ném lỗi để ROLLBACK thay vì commit nửa vời khi thu hồi phiên hiện tại thất bại, và logout thu hồi cả family_id theo đúng thứ tự khóa', async () => {
    const principal = makeActivePrincipal();
    const currentPassword = 'current strong passphrase 2026!';
    const hashed = await hashPassword(currentPassword);
    const rawTicket = generateSecureToken(32);
    const validTicketHash = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: principal.user.id,
      sessionFamilyId: principal.session.familyId,
    });
    const validTicketRow: VerificationTokenRow = {
      id: '01950000-0000-7000-8000-000000004088',
      userId: principal.user.id,
      purpose: 'password_change_ticket',
      tokenHash: validTicketHash,
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: null,
      createdAt: new Date(),
    };

    const txRolledBack = vi.fn();
    const callOrder: string[] = [];

    const service = new AuthService({
      rateLimiter: makeAllowRateLimiter(),
      loginProtection: {
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
      },
      repository: {
        getDb: () => ({
          transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
            try {
              return await fn({});
            } catch (err) {
              txRolledBack();
              throw err;
            }
          },
        }),
        findEmailIdentityByUserId: vi.fn().mockResolvedValue({
          id: '01950000-0000-7000-8000-000000004002',
          userId: principal.user.id,
          provider: 'email_password',
          identifierNormalized: 'rollback@tomato.test',
          passwordHash: hashed.hash,
          pepperVersion: hashed.pepperVersion,
          verifiedAt: new Date(),
          failedLoginAttempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        findVerificationTokenByHashForUser: vi.fn().mockResolvedValue(validTicketRow),
        lockUserById: vi.fn().mockResolvedValue(principal.user),
        findSessionByPublicIdForUser: vi.fn().mockResolvedValue(principal.session),
        acquireSessionFamilyLock: vi.fn().mockResolvedValue(undefined),
        lockVerificationTokenByHashForUser: vi.fn().mockResolvedValue(validTicketRow),
        updateIdentityPasswordHash: vi.fn().mockResolvedValue(true),
        resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
        consumeAllUnconsumedTokensByPurpose: vi.fn().mockResolvedValue(undefined),
        revokeAllUserSessions: vi.fn().mockResolvedValue(1),
        // Giả lập thu hồi phiên hiện tại thất bại bất ngờ sau khi đã cập nhật password trong tx.
        revokeSessionById: vi.fn().mockResolvedValue(false),
      } as unknown as AuthRepository,
      emailProvider: { provider: 'memory', send: vi.fn() },
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    await expect(
      service.changePassword(
        principal,
        {
          currentPassword,
          newPassword: 'brand new safe passphrase 2028!',
        },
        rawTicket,
        { ipAddress: '203.0.113.80', rateLimitIpKey: '203.0.113.80', userAgent: 'Vitest' },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthDomainError && err.status === 401 && err.code === 'UNAUTHORIZED',
    );
    expect(txRolledBack).toHaveBeenCalledTimes(1);

    // Kiểm tra logoutCurrentSession khóa đúng thứ tự `users FOR SHARE` -> `advisory(familyId)` -> `revokeSessionFamily`.
    const sessionSvc = new SessionService({
      rateLimiter: makeAllowRateLimiter(),
      auditLogService: {
        record: vi.fn().mockResolvedValue({ id: 'audit-logout' }),
      } as unknown as AuditLogService,
      repository: {
        getDb: () => ({
          transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
        }),
        findSessionByRefreshTokenHash: vi.fn().mockResolvedValue(principal.session),
        lockUserById: vi.fn(async () => {
          callOrder.push('lockUserById:share');
          return principal.user;
        }),
        acquireSessionFamilyLock: vi.fn(async () => {
          callOrder.push('acquireSessionFamilyLock');
        }),
        revokeSessionFamily: vi.fn(async () => {
          callOrder.push('revokeSessionFamily');
          return [principal.session.id];
        }),
      } as unknown as AuthRepository,
    });

    const logoutRes = await sessionSvc.logoutCurrentSession(
      { accessToken: null, refreshToken: generateSecureToken(32) },
      { ipAddress: '203.0.113.81', rateLimitIpKey: '203.0.113.81', userAgent: 'Vitest' },
    );
    expect(logoutRes.loggedOut).toBe(true);
    expect(callOrder).toEqual([
      'lockUserById:share',
      'acquireSessionFamilyLock',
      'revokeSessionFamily',
    ]);
  });
});
