import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as registerPost } from '@/app/api/v1/auth/register/route';
import { POST as resendPost } from '@/app/api/v1/auth/resend-verification/route';
import { POST as verifyPost } from '@/app/api/v1/auth/verify-email/route';
import type { CaptchaProvider } from '@/core/captcha';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { isPostgresUniqueViolation } from '@/core/db/errors';
import type { EmailMessage, EmailProvider } from '@/core/email';
import { RateLimiter } from '@/core/redis/rate-limiter';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AUTH_MESSAGES,
  AuthDomainError,
  AuthService,
  resetAuthServiceForTesting,
  setAuthServiceForTesting,
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

describe('Security M2: CSRF/Origin Guard, Anti-Enumeration, Rate-Limit-First & PG 23505 Detection', () => {
  const injectedEnvKeys: string[] = [];
  let allowedOrigin = 'http://127.0.0.1:3000';

  beforeAll(() => {
    // Đảm bảo test luôn chạy độc lập cả trên CI (ALLOWED_ORIGINS=http://127.0.0.1:3000),
    // máy local có `.env.local` (http://localhost:3000) và môi trường sạch không có `.env.local`.
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
  });

  it('chặn 403 CSRF_VALIDATION_FAILED kèm Cache-Control: no-store khi gọi /register, /verify-email, /resend-verification sai Origin hoặc cross-site', async () => {
    const endpoints = [
      { url: `${allowedOrigin}/api/v1/auth/register`, handler: registerPost },
      { url: `${allowedOrigin}/api/v1/auth/verify-email`, handler: verifyPost },
      { url: `${allowedOrigin}/api/v1/auth/resend-verification`, handler: resendPost },
    ];

    for (const { url, handler } of endpoints) {
      // 1. Thiếu Origin
      const noOriginRes = await handler(
        new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(noOriginRes.status).toBe(403);
      expect(noOriginRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
      const noOriginJson = (await noOriginRes.json()) as { error: { code: string } };
      expect(noOriginJson.error.code).toBe('CSRF_VALIDATION_FAILED');

      // 2. Sai Origin (evil domain)
      const evilOriginRes = await handler(
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
      expect(evilOriginRes.status).toBe(403);

      // 3. Cross-site Fetch Metadata
      const crossSiteRes = await handler(
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
      expect(crossSiteRes.status).toBe(403);
    }
  });

  it('chặn JSON payload vượt quá 16 KiB (413) và JSON hỏng (400)', async () => {
    const hugeBody = JSON.stringify({ padding: 'x'.repeat(20_000) });
    const largeRes = await registerPost(
      new Request(`${allowedOrigin}/api/v1/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: hugeBody,
      }),
    );
    expect(largeRes.status).toBe(413);
    expect(largeRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);

    const invalidJsonRes = await registerPost(
      new Request(`${allowedOrigin}/api/v1/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: '{not-valid-json',
      }),
    );
    expect(invalidJsonRes.status).toBe(400);
  });

  it('isPostgresUniqueViolation phát hiện đúng cả lỗi pg trực tiếp lẫn lỗi bọc DrizzleQueryError.cause', () => {
    const directPgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'idx_identities_provider_identifier',
    });
    expect(isPostgresUniqueViolation(directPgError)).toBe(true);
    expect(isPostgresUniqueViolation(directPgError, 'idx_identities_provider_identifier')).toBe(
      true,
    );
    expect(isPostgresUniqueViolation(directPgError, 'other_constraint')).toBe(false);

    const wrappedDrizzleError = new Error('Failed query', { cause: directPgError });
    expect(isPostgresUniqueViolation(wrappedDrizzleError)).toBe(true);

    const unrelatedError = new Error('Connection lost', {
      cause: Object.assign(new Error('timeout'), { code: '57014' }),
    });
    expect(isPostgresUniqueViolation(unrelatedError)).toBe(false);
  });

  it('Rate Limit chạy TRƯỚC khi gọi Turnstile, truy vấn DB hay băm Argon2id', async () => {
    const mockConsume = vi.fn().mockResolvedValue({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: Date.now() + 45_000,
      retryAfterSeconds: 45,
    });
    const mockVerifyCaptcha = vi.fn();
    const mockFindUser = vi.fn();
    const mockSendEmail = vi.fn();

    const service = new AuthService({
      rateLimiter: { consume: mockConsume } as unknown as RateLimiter,
      captchaProvider: { provider: 'stub', verify: mockVerifyCaptcha } as CaptchaProvider,
      repository: { findEmailIdentityWithUser: mockFindUser } as unknown as AuthRepository,
      emailProvider: { provider: 'memory', send: mockSendEmail } as EmailProvider,
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    setAuthServiceForTesting(service);

    const response = await registerPost(
      new Request(`${allowedOrigin}/api/v1/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          'x-forwarded-for': '198.51.100.77',
        },
        body: JSON.stringify({
          email: 'rate-limited@example.com',
          password: 'short', // Cố tình sai để xác nhận Rate Limit chặn trước cả Zod!
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const json = (await response.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('RATE_LIMITED');
    expect(mockVerifyCaptcha).not.toHaveBeenCalled();
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('Turnstile thất bại bị chặn 400 CAPTCHA_INVALID trước khi truy vấn DB', async () => {
    const mockFindUser = vi.fn();
    const service = new AuthService({
      rateLimiter: {
        consume: vi.fn().mockResolvedValue({
          allowed: true,
          limit: 5,
          remaining: 4,
          resetAt: Date.now() + 60_000,
          retryAfterSeconds: 0,
        }),
      } as unknown as RateLimiter,
      captchaProvider: {
        provider: 'stub',
        verify: vi
          .fn()
          .mockResolvedValue({ success: false, errorCodes: ['invalid-input-response'] }),
      },
      repository: { findEmailIdentityWithUser: mockFindUser } as unknown as AuthRepository,
      emailProvider: { provider: 'memory', send: vi.fn() },
      auditLogService: { record: vi.fn() } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    await expect(
      service.register(
        {
          email: 'bot@example.com',
          password: 'cụm mật khẩu an toàn hợp lệ 2026',
          displayName: 'Test User',
          dateOfBirth: '1999-01-01',
          acceptedTerms: true,
          captchaToken: 'invalid-captcha',
        },
        { ipAddress: '198.51.100.12', rateLimitIpKey: '198.51.100.12', userAgent: 'Vitest' },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthDomainError && err.status === 400 && err.code === 'CAPTCHA_INVALID',
    );

    expect(mockFindUser).not.toHaveBeenCalled();
  });

  it('đăng ký trùng email đã active trả lỗi 409 CONFLICT rõ ràng để điều hướng sang Đăng nhập và ghi Audit Log', async () => {
    const sentMessages: EmailMessage[] = [];
    const auditRecord = vi.fn().mockResolvedValue({ id: 'audit-1' });

    const service = new AuthService({
      rateLimiter: {
        consume: vi.fn().mockResolvedValue({
          allowed: true,
          limit: 5,
          remaining: 4,
          resetAt: Date.now() + 60_000,
          retryAfterSeconds: 0,
        }),
      } as unknown as RateLimiter,
      captchaProvider: {
        provider: 'stub',
        verify: vi.fn().mockResolvedValue({ success: true, errorCodes: [] }),
      },
      repository: {
        findEmailIdentityWithUser: vi.fn().mockResolvedValue({
          user: {
            id: '01950000-0000-7000-8000-000000000001',
            publicId: 'f5c8043b-4661-4c8b-848f-f520c1adb0f7',
            displayName: 'Chủ Tài Khoản',
            dateOfBirth: '1998-05-05',
            status: 'active',
            createdAt: new Date('2025-01-01T00:00:00Z'),
            updatedAt: new Date('2025-01-01T00:00:00Z'),
            deletedAt: null,
          },
          identity: {
            id: '01950000-0000-7000-8000-000000000002',
            userId: '01950000-0000-7000-8000-000000000001',
            provider: 'email_password',
            identifierNormalized: 'existing-active@example.com',
            passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
            pepperVersion: 1,
            verifiedAt: new Date('2025-01-01T00:00:00Z'),
            failedLoginAttempts: 0,
            createdAt: new Date('2025-01-01T00:00:00Z'),
            updatedAt: new Date('2025-01-01T00:00:00Z'),
          },
        }),
      } as unknown as AuthRepository,
      emailProvider: {
        provider: 'memory',
        send: vi.fn(async (msg: EmailMessage) => {
          sentMessages.push(msg);
        }),
      },
      auditLogService: { record: auditRecord } as unknown as AuditLogService,
      appUrl: allowedOrigin,
    });

    await expect(
      service.register(
        {
          email: 'EXISTING-ACTIVE@example.com',
          password: 'cụm mật khẩu an toàn khác hẳn 2026',
          displayName: 'Người Thử Trùng',
          dateOfBirth: '1999-03-03',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        { ipAddress: '198.51.100.20', rateLimitIpKey: '198.51.100.20', userAgent: 'Vitest' },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthDomainError &&
        err.status === 409 &&
        err.code === 'CONFLICT' &&
        err.message === AUTH_MESSAGES.emailAlreadyExists,
    );

    expect(sentMessages).toHaveLength(0);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REGISTER',
        metadata: expect.objectContaining({ outcome: 'duplicate_existing_account' }),
      }),
    );
  });
});
