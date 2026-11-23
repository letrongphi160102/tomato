import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import type { CaptchaProvider } from '@/core/captcha';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { hashPassword } from '@/core/crypto/password';
import type { SessionRow, UserRow, UserStatus } from '@/core/db/schema';
import { EmailDeliveryError, type EmailMessage, type EmailProvider } from '@/core/email';
import {
  computeLoginBackoffSeconds,
  isCaptchaRequiredForFailureCount,
  type LoginBruteForceStore,
  type RateLimiter,
} from '@/core/redis';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD,
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
  EMAIL_PROVIDER: 'mailpit',
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

/**
 * In-memory LoginBruteForceStore tuân thủ chính xác hợp đồng Redis Lua script (1s->2s->4s->8s, Turnstile mốc 5).
 */
function createMemoryLoginProtection(now: () => number): LoginBruteForceStore {
  const counts = new Map<string, number>();
  const backoffUntil = new Map<string, number>();

  const keyOf = (email: string, ip: string) => `${email}\u0000${ip}`;

  return {
    async checkPair(email, ip) {
      const k = keyOf(email, ip);
      const count = counts.get(k) ?? 0;
      const until = backoffUntil.get(k) ?? 0;
      const remainingMs = Math.max(0, until - now());
      if (remainingMs === 0) {
        backoffUntil.delete(k);
      }
      return {
        failureCount: count,
        backoffRemainingMs: remainingMs,
        retryAfterSeconds: remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0,
        requireCaptcha: isCaptchaRequiredForFailureCount(count),
      };
    },
    async recordPairFailure(email, ip) {
      const k = keyOf(email, ip);
      const next = (counts.get(k) ?? 0) + 1;
      counts.set(k, next);
      const backoffSec = computeLoginBackoffSeconds(next);
      if (backoffSec > 0) {
        backoffUntil.set(k, now() + backoffSec * 1000);
      }
      return {
        failureCount: next,
        backoffSeconds: backoffSec,
        requireCaptcha: isCaptchaRequiredForFailureCount(next),
      };
    },
    async clearPair(email, ip) {
      const k = keyOf(email, ip);
      counts.delete(k);
      backoffUntil.delete(k);
    },
  };
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Security M5: Chống Brute-Force thông minh, Anti-Account-DoS, Lockout mốc 50 & Kiểm tra rò rỉ log', () => {
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

  function makeLoginReq(body: Record<string, unknown>, ip: string): Request {
    return new Request(`${allowedOrigin}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: allowedOrigin,
        'Sec-Fetch-Site': 'same-origin',
        'x-forwarded-for': ip,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
    });
  }

  it('áp dụng Exponential Backoff (1s -> 2s -> 4s -> 8s) và Turnstile từ lần sai thứ 5 TRƯỚC khi chạm DB/Argon2id, đồng thời không làm chậm chủ tài khoản ở IP quen', async () => {
    let clockMs = 1_700_000_000_000;
    const validPassword = 'owner strong passphrase 2026!';
    const hashed = await hashPassword(validPassword);

    const userRow: UserRow = {
      id: '01950000-0000-7000-8000-000000005001',
      publicId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      username: 'owner_m5',
      fullName: 'Chủ Tài Khoản',
      gender: 'female',
      dateOfBirth: '1997-04-12',
      status: 'active',
      createdAt: new Date(clockMs),
      updatedAt: new Date(clockMs),
      deletedAt: null,
    };

    const sessionRow: SessionRow = {
      id: '01950000-0000-7000-8000-000000005010',
      publicId: 'session-owner-m5-1',
      userId: userRow.id,
      familyId: 'family-owner-m5-1',
      refreshTokenHash: 'a'.repeat(64),
      deviceInfo: 'Chrome 130 / Windows 10/11',
      ipAddress: '198.51.100.10',
      lastUsedAt: new Date(clockMs),
      expiresAt: new Date(clockMs + 30 * 86_400_000),
      revokedAt: null,
      revokeReason: null,
      createdAt: new Date(clockMs),
    };

    let dbFailedCount = 0;
    const findIdentitySpy = vi.fn(async (email: string) => {
      if (email === 'owner@tomato.test') {
        return {
          user: userRow,
          identity: {
            id: '01950000-0000-7000-8000-000000005002',
            userId: userRow.id,
            provider: 'email_password' as const,
            identifierNormalized: 'owner@tomato.test',
            passwordHash: hashed.hash,
            pepperVersion: hashed.pepperVersion,
            verifiedAt: new Date(clockMs),
            failedLoginAttempts: dbFailedCount,
            createdAt: new Date(clockMs),
            updatedAt: new Date(clockMs),
          },
        };
      }
      return null;
    });

    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
      }),
      findEmailIdentityWithUser: findIdentitySpy,
      incrementFailedLoginAttemptsAndMaybeLock: vi.fn(async () => {
        dbFailedCount += 1;
        return {
          failedLoginAttempts: dbFailedCount,
          lockedNow: false,
          userStatus: 'active' as UserStatus,
        };
      }),
      lockUserById: vi.fn().mockResolvedValue(userRow),
      resetFailedLoginAttempts: vi.fn(async () => {
        dbFailedCount = 0;
      }),
      createSession: vi.fn().mockResolvedValue(sessionRow),
    } as unknown as AuthRepository;

    const captchaVerifySpy = vi.fn(async ({ token }: { token: string }) => ({
      success: token === 'valid-turnstile-token',
      errorCodes: token === 'valid-turnstile-token' ? [] : ['invalid-input-response'],
    }));
    const captchaProvider: CaptchaProvider = {
      provider: 'turnstile',
      verify: captchaVerifySpy,
    };

    const loginProtection = createMemoryLoginProtection(() => clockMs);
    const auditRecord = vi.fn().mockResolvedValue({ id: 'audit-m5' });
    const rateLimiter = makeAllowRateLimiter();
    const sessionService = new SessionService({
      repository,
      rateLimiter,
      auditLogService: { record: auditRecord } as unknown as AuditLogService,
      now: () => new Date(clockMs),
    });
    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter,
      loginProtection,
      captchaProvider,
      auditLogService: { record: auditRecord } as unknown as AuditLogService,
      now: () => new Date(clockMs),
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);

    const attackerIp = '203.0.113.77';
    const ownerIp = '198.51.100.10';

    // 1. Sai lần 1, 2, 3 từ IP kẻ tấn công -> đều trả 401 chưa đòi Turnstile.
    for (let i = 1; i <= 3; i += 1) {
      const res = await loginPost(
        makeLoginReq({ email: 'owner@tomato.test', password: `wrong-pass-${i}` }, attackerIp),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { requireCaptcha?: boolean } };
      expect(body.error.requireCaptcha).toBeUndefined();
    }

    // Ngay sau lần sai thứ 3 -> bị chặn Exponential Backoff 1s TRƯỚC khi chạm DB!
    const callsBeforeBackoff1 = findIdentitySpy.mock.calls.length;
    const blocked1 = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-retry' }, attackerIp),
    );
    expect(blocked1.status).toBe(429);
    expect(blocked1.headers.get('Retry-After')).toBe('1');
    expect(blocked1.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(findIdentitySpy.mock.calls.length).toBe(callsBeforeBackoff1);

    // Chờ hết 1s -> sai lần 4 -> kích hoạt backoff 2s.
    clockMs += 1001;
    const fail4 = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-pass-4' }, attackerIp),
    );
    expect(fail4.status).toBe(401);

    const blocked2 = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-retry-2' }, attackerIp),
    );
    expect(blocked2.status).toBe(429);
    expect(blocked2.headers.get('Retry-After')).toBe('2');

    // Chờ hết 2s -> sai lần 5 -> kích hoạt backoff 4s VÀ trả `requireCaptcha: true` cho Frontend.
    clockMs += 2001;
    const fail5 = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-pass-5' }, attackerIp),
    );
    expect(fail5.status).toBe(401);
    const fail5Json = (await fail5.json()) as {
      error: { code: string; requireCaptcha?: boolean };
    };
    expect(fail5Json.error.code).toBe('INVALID_CREDENTIALS');
    expect(fail5Json.error.requireCaptcha).toBe(true);

    // Thử ngay trong lúc backoff 4s -> 429 + Retry-After: 4 + giữ nguyên requireCaptcha: true.
    const blocked4 = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-retry-4' }, attackerIp),
    );
    expect(blocked4.status).toBe(429);
    expect(blocked4.headers.get('Retry-After')).toBe('4');
    const blocked4Json = (await blocked4.json()) as { error: { requireCaptcha?: boolean } };
    expect(blocked4Json.error.requireCaptcha).toBe(true);

    // Chờ hết 4s -> thử lần 6 KHÔNG kèm captchaToken -> 400 CAPTCHA_REQUIRED TRƯỚC khi truy DB!
    clockMs += 4001;
    const callsBeforeCaptcha = findIdentitySpy.mock.calls.length;
    const missingCaptcha = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: 'wrong-pass-6' }, attackerIp),
    );
    expect(missingCaptcha.status).toBe(400);
    const missingJson = (await missingCaptcha.json()) as {
      error: { code: string; requireCaptcha?: boolean };
    };
    expect(missingJson.error.code).toBe('CAPTCHA_REQUIRED');
    expect(missingJson.error.requireCaptcha).toBe(true);
    expect(findIdentitySpy.mock.calls.length).toBe(callsBeforeCaptcha);

    // Gửi captchaToken sai -> 400 CAPTCHA_INVALID TRƯỚC khi truy DB!
    const badCaptcha = await loginPost(
      makeLoginReq(
        { email: 'owner@tomato.test', password: 'wrong-pass-6', captchaToken: 'bad-token' },
        attackerIp,
      ),
    );
    expect(badCaptcha.status).toBe(400);
    expect(((await badCaptcha.json()) as { error: { code: string } }).error.code).toBe(
      'CAPTCHA_INVALID',
    );
    expect(findIdentitySpy.mock.calls.length).toBe(callsBeforeCaptcha);

    // Gửi captchaToken hợp lệ nhưng sai mật khẩu (lần sai 6) -> 401 + requireCaptcha: true + backoff 8s!
    const fail6 = await loginPost(
      makeLoginReq(
        {
          email: 'owner@tomato.test',
          password: 'wrong-pass-6',
          captchaToken: 'valid-turnstile-token',
        },
        attackerIp,
      ),
    );
    expect(fail6.status).toBe(401);
    const blocked8 = await loginPost(
      makeLoginReq(
        {
          email: 'owner@tomato.test',
          password: 'wrong-retry-8',
          captchaToken: 'valid-turnstile-token',
        },
        attackerIp,
      ),
    );
    expect(blocked8.status).toBe(429);
    expect(blocked8.headers.get('Retry-After')).toBe('8');

    // CHỐNG DoS TÀI KHOẢN CHỦ: Ngay trong lúc IP kẻ tấn công đang bị khóa 8s + ép Turnstile,
    // chủ tài khoản từ IP quen đăng nhập KHÔNG CẦN Turnstile và KHÔNG bị làm chậm!
    const ownerLoginRes = await loginPost(
      makeLoginReq({ email: 'owner@tomato.test', password: validPassword }, ownerIp),
    );
    expect(ownerLoginRes.status).toBe(200);
    expect(dbFailedCount).toBe(0);
  });

  it('Anti-Enumeration tại mốc 5 lần sai: email không tồn tại cũng kích hoạt đúng requireCaptcha: true giống hệt email có thật', async () => {
    let clockMs = 1_700_000_000_000;
    const loginProtection = createMemoryLoginProtection(() => clockMs);

    setAuthServiceForTesting(
      new AuthService({
        repository: {
          findEmailIdentityWithUser: vi.fn().mockResolvedValue(null),
        } as unknown as AuthRepository,
        rateLimiter: makeAllowRateLimiter(),
        loginProtection,
        auditLogService: {
          record: vi.fn().mockResolvedValue({ id: 'a' }),
        } as unknown as AuditLogService,
        now: () => new Date(clockMs),
      }),
    );

    const ip = '203.0.113.88';
    for (let i = 1; i <= 5; i += 1) {
      clockMs += 10_000;
      const res = await loginPost(
        makeLoginReq({ email: 'ghost-user@tomato.test', password: `wrong-${i}` }, ip),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as {
        error: { code: string; message: string; requireCaptcha?: boolean };
      };
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(body.error.message).toBe(AUTH_MESSAGES.invalidCredentials);
      if (i < 5) {
        expect(body.error.requireCaptcha).toBeUndefined();
      } else {
        expect(body.error.requireCaptcha).toBe(true);
      }
    }
  });

  it('Mốc 50 lần sai liên tiếp: khóa nguyên tử sang locked, ghi ACCOUNT_LOCKED, gửi email cảnh báo (kể cả khi SMTP lỗi không phá 401), và không lộ trạng thái ở mật khẩu sai', async () => {
    const validPassword = 'lockout target passphrase 2026!';
    const hashed = await hashPassword(validPassword);
    let currentStatus: UserStatus = 'active';
    let currentFailedAttempts = ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD - 1; // 49

    const sentEmails: EmailMessage[] = [];
    const emailProvider: EmailProvider = {
      provider: 'memory',
      send: vi.fn(async (msg: EmailMessage) => {
        sentEmails.push(msg);
      }),
    };
    const auditRecord = vi.fn().mockResolvedValue({ id: 'audit-lock' });

    const makeUser = (): UserRow => ({
      id: '01950000-0000-7000-8000-000000005050',
      publicId: 'e1a5a057-0f04-47b2-95f4-0d6464275050',
      username: 'lock_target',
      fullName: 'Người Dùng Mục Tiêu',
      gender: 'male',
      dateOfBirth: '1995-03-20',
      status: currentStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    const repository = {
      getDb: () => ({
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
      }),
      findEmailIdentityWithUser: vi.fn(async () => ({
        user: makeUser(),
        identity: {
          id: '01950000-0000-7000-8000-000000005051',
          userId: '01950000-0000-7000-8000-000000005050',
          provider: 'email_password' as const,
          identifierNormalized: 'lock-target@tomato.test',
          passwordHash: hashed.hash,
          pepperVersion: hashed.pepperVersion,
          verifiedAt: new Date(),
          failedLoginAttempts: currentFailedAttempts,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })),
      incrementFailedLoginAttemptsAndMaybeLock: vi.fn(async () => {
        if (currentStatus !== 'active') {
          return {
            failedLoginAttempts: currentFailedAttempts,
            lockedNow: false,
            userStatus: currentStatus,
          };
        }
        currentFailedAttempts += 1;
        const lockedNow = currentFailedAttempts >= ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD;
        if (lockedNow) {
          currentStatus = 'locked';
        }
        return {
          failedLoginAttempts: currentFailedAttempts,
          lockedNow,
          userStatus: currentStatus,
        };
      }),
    } as unknown as AuthRepository;

    setAuthServiceForTesting(
      new AuthService({
        repository,
        rateLimiter: makeAllowRateLimiter(),
        loginProtection: createMemoryLoginProtection(() => Date.now()),
        emailProvider,
        auditLogService: { record: auditRecord } as unknown as AuditLogService,
        appUrl: 'https://tomato.example.com',
      }),
    );

    // Lần sai thứ 50 -> khóa tài khoản + ghi Audit Log ACCOUNT_LOCKED + gửi email cảnh báo,
    // NHƯNG vẫn trả 401 INVALID_CREDENTIALS cho mật khẩu sai để chống dò trạng thái tài khoản!
    const fail50Res = await loginPost(
      makeLoginReq(
        { email: 'lock-target@tomato.test', password: 'wrong-50th-password' },
        '203.0.113.50',
      ),
    );
    expect(fail50Res.status).toBe(401);
    expect(((await fail50Res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(currentStatus).toBe('locked');
    expect(currentFailedAttempts).toBe(50);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ACCOUNT_LOCKED',
        ipAddress: '203.0.113.50',
        metadata: expect.objectContaining({
          failedLoginAttempts: 50,
          reason: 'brute_force_threshold_reached',
        }),
      }),
      expect.anything(),
    );
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe('lock-target@tomato.test');
    expect(sentEmails[0]!.html).toContain('203.0.113.50');
    expect(sentEmails[0]!.html).toContain('https://tomato.example.com/forgot-password');

    // Lần sai thứ 51 (khi tài khoản ĐÃ locked) -> KHÔNG gửi trùng email cảnh báo!
    const fail51Res = await loginPost(
      makeLoginReq(
        { email: 'lock-target@tomato.test', password: 'wrong-51st-password' },
        '203.0.113.51',
      ),
    );
    expect(fail51Res.status).toBe(401);
    expect(sentEmails).toHaveLength(1);

    // Khi chủ tài khoản nhập ĐÚNG mật khẩu -> nhận 403 ACCOUNT_LOCKED hướng dẫn mở khóa qua Quên mật khẩu.
    const correctPassRes = await loginPost(
      makeLoginReq({ email: 'lock-target@tomato.test', password: validPassword }, '198.51.100.10'),
    );
    expect(correctPassRes.status).toBe(403);
    expect(((await correctPassRes.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_LOCKED',
    );

    // Xác minh cơ chế fail-safe khi dịch vụ SMTP tạm lỗi ở lần sai thứ 50: vẫn trả 401 sạch.
    currentStatus = 'active';
    currentFailedAttempts = ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD - 1;
    (emailProvider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new EmailDeliveryError('gmail', 'Temporary outage'),
    );
    const fail50Outage = await loginPost(
      makeLoginReq(
        { email: 'lock-target@tomato.test', password: 'wrong-during-outage' },
        '203.0.113.52',
      ),
    );
    expect(fail50Outage.status).toBe(401);
    expect(currentStatus).toBe('locked');
  });

  it('Kiểm toán rò rỉ log toàn bộ codebase `src/`: không tồn tại console.log/debug/info/warn và console.error chỉ dùng cho fail-fast env boot', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const sourceFiles = collectSourceFiles(srcDir);
    expect(sourceFiles.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf8');
      const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

      if (/\bconsole\.(log|debug|info|warn|dir|trace|table)\s*\(/.test(content)) {
        violations.push(`${relative}: chứa lệnh console.* không được phép`);
      }

      if (/\bconsole\.error\s*\(/.test(content) && relative !== 'src/instrumentation.ts') {
        violations.push(`${relative}: console.error ngoài instrumentation fail-fast`);
      }
    }

    expect(violations).toEqual([]);
  });
});
