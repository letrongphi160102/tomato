import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as forgotPasswordPost } from '@/app/api/v1/auth/forgot-password/route';
import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as resetPasswordPost } from '@/app/api/v1/auth/reset-password/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { auditLogs, authIdentities, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import {
  ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD,
  AuthRepository,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';

class MemoryCaptureEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

function makeUniqueEmail(label: string): string {
  return `m5-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tomato.test`;
}

function makePostRequest(pathname: string, body: unknown, ip: string, userAgent?: string): Request {
  const origin = getTestOrigin();
  return new Request(`${origin}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'x-forwarded-for': ip,
      'user-agent':
        userAgent ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
}

describe('Integration M5: Brute-Force Backoff (1s->2s->4s->8s), Turnstile mốc 5, Anti-Account-DoS & Lockout mốc 50 (PostgreSQL + Redis thật)', () => {
  const createdUserIds: string[] = [];
  let testClockMs = Date.now();
  let emailCapture: MemoryCaptureEmailProvider;

  async function seedActiveUser(email: string, password: string) {
    const db = getDb();
    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const identityId = generateUuidV7();
    const hashed = await hashPassword(password);
    const now = new Date(testClockMs);

    const m5Username = `m5_${publicId.replace(/-/g, '').slice(0, 14)}`;
    await db.insert(users).values({
      id: userId,
      publicId,
      username: m5Username,
      handle: m5Username,
      handleNormalized: m5Username,
      fullName: 'Nguyễn Bảo Vệ M5',
      gender: 'male',
      dateOfBirth: '1996-06-15',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(authIdentities).values({
      id: identityId,
      userId,
      provider: 'email_password',
      identifierNormalized: email,
      passwordHash: hashed.hash,
      pepperVersion: hashed.pepperVersion,
      verifiedAt: now,
      failedLoginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    createdUserIds.push(userId);
    return { userId, publicId, identityId, email };
  }

  beforeEach(() => {
    testClockMs = Date.now();
    emailCapture = new MemoryCaptureEmailProvider();

    const suffix = `${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const redis = getRedisClient();
    const repository = new AuthRepository();
    const auditLogService = new AuditLogService();
    const rateLimiter = new RateLimiter(redis, {
      keyPrefix: `tomato:rl:m5:${suffix}`,
      now: () => testClockMs,
    });
    const loginProtection = new LoginBruteForceGuard(redis, {
      keyPrefix: `tomato:bf:m5:${suffix}`,
      now: () => testClockMs,
    });

    const sessionService = new SessionService({
      repository,
      rateLimiter,
      auditLogService,
      now: () => new Date(testClockMs),
    });

    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter,
      loginProtection,
      emailProvider: emailCapture,
      auditLogService,
      appUrl: getTestOrigin(),
      now: () => new Date(testClockMs),
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
  });

  afterAll(async () => {
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();

    const db = getDb();
    for (const userId of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await Promise.all([closeDatabasePool(), closeRedisClient()]);
  });

  it('Redis thật: Exponential Backoff 1s->2s->4s->8s, Turnstile từ lần sai 5 và Anti-Account-DoS cho IP chủ đã từng đăng nhập', async () => {
    const email = makeUniqueEmail('backoff-antidos');
    const password = 'owner real passphrase m5 2026!';
    const seeded = await seedActiveUser(email, password);

    const ownerIp = '198.51.100.21';
    const attackerIp = '203.0.113.21';

    // 1. Chủ tài khoản đăng nhập thành công lần đầu từ IP/thiết bị quen.
    const initialOwnerLogin = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password }, ownerIp),
    );
    expect(initialOwnerLogin.status).toBe(200);

    // 2. Kẻ tấn công thử sai từ IP lạ: lần 1, 2, 3 -> kích hoạt backoff 1s.
    for (let i = 1; i <= 3; i += 1) {
      const res = await loginPost(
        makePostRequest('/api/v1/auth/login', { email, password: `bad-${i}` }, attackerIp),
      );
      expect(res.status).toBe(401);
    }

    const wait1 = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: 'bad-retry-1' }, attackerIp),
    );
    expect(wait1.status).toBe(429);
    expect(wait1.headers.get('Retry-After')).toBe('1');

    // Hết 1s -> lần sai 4 -> backoff 2s.
    testClockMs += 1001;
    expect(
      (
        await loginPost(
          makePostRequest('/api/v1/auth/login', { email, password: 'bad-4' }, attackerIp),
        )
      ).status,
    ).toBe(401);
    const wait2 = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: 'bad-retry-2' }, attackerIp),
    );
    expect(wait2.status).toBe(429);
    expect(wait2.headers.get('Retry-After')).toBe('2');

    // Hết 2s -> lần sai 5 -> backoff 4s + `requireCaptcha: true`.
    testClockMs += 2001;
    const fail5 = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: 'bad-5' }, attackerIp),
    );
    expect(fail5.status).toBe(401);
    const fail5Json = (await fail5.json()) as { error: { requireCaptcha?: boolean } };
    expect(fail5Json.error.requireCaptcha).toBe(true);

    const wait4 = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: 'bad-retry-4' }, attackerIp),
    );
    expect(wait4.status).toBe(429);
    expect(wait4.headers.get('Retry-After')).toBe('4');

    // Hết 4s -> lần 6 có Turnstile dummy pass + mật khẩu sai -> 401 -> kích hoạt backoff 8s
    // (tổng đúng 10 request trên attackerIp: 6 lần thử + 4 lần probe backoff, vẫn nằm trong ngưỡng loginByIp=10/15p).
    testClockMs += 4001;
    const fail6 = await loginPost(
      makePostRequest(
        '/api/v1/auth/login',
        { email, password: 'bad-6', captchaToken: 'dummy-turnstile-token' },
        attackerIp,
      ),
    );
    expect(fail6.status).toBe(401);
    const wait8 = await loginPost(
      makePostRequest(
        '/api/v1/auth/login',
        { email, password: 'bad-retry-8', captchaToken: 'dummy-turnstile-token' },
        attackerIp,
      ),
    );
    expect(wait8.status).toBe(429);
    expect(wait8.headers.get('Retry-After')).toBe('8');

    // Xác minh riêng trên IP kẻ tấn công thứ 2: sau 5 lần sai mà lần 6 thiếu `captchaToken` -> 400 CAPTCHA_REQUIRED.
    const attackerIp2 = '203.0.113.22';
    for (let i = 1; i <= 5; i += 1) {
      testClockMs += 10_000;
      const res = await loginPost(
        makePostRequest('/api/v1/auth/login', { email, password: `ip2-bad-${i}` }, attackerIp2),
      );
      expect(res.status).toBe(401);
    }
    testClockMs += 10_000;
    const noCaptcha = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: 'ip2-bad-6' }, attackerIp2),
    );
    expect(noCaptcha.status).toBe(400);
    const noCaptchaJson = (await noCaptcha.json()) as {
      error: { code: string; requireCaptcha?: boolean };
    };
    expect(noCaptchaJson.error.code).toBe('CAPTCHA_REQUIRED');
    expect(noCaptchaJson.error.requireCaptcha).toBe(true);

    // 3. Anti-Account-DoS: chủ tài khoản đăng nhập từ IP quen KHÔNG bị làm chậm hay đòi Turnstile,
    //    đồng thời reset `failed_login_attempts = 0` trong PostgreSQL.
    const ownerRes = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password }, ownerIp),
    );
    expect(ownerRes.status).toBe(200);

    const db = getDb();
    const [identityRow] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, seeded.identityId));
    expect(identityRow?.failedLoginAttempts).toBe(0);
  });

  it('PostgreSQL thật: chạm mốc 50 lần sai (phân tán nhiều IP) -> tự khóa `locked`, ghi Audit Log `ACCOUNT_LOCKED`, gửi email cảnh báo và mở khóa bằng Quên mật khẩu', async () => {
    const email = makeUniqueEmail('lockout-50');
    const password = 'original strong passphrase 2026!';
    const newPassword = 'recovered strong passphrase 2027!';
    const seeded = await seedActiveUser(email, password);

    const db = getDb();
    // Đưa bộ đếm lên 47 lần sai trước đó để tiết kiệm thời gian băm Argon2id nhưng vẫn kiểm thử
    // 3 lần sai liên tiếp thực tế từ nhiều IP vượt đúng ngưỡng 50 trên PostgreSQL thật.
    await db
      .update(authIdentities)
      .set({ failedLoginAttempts: ACCOUNT_LOCK_FAILED_ATTEMPTS_THRESHOLD - 3 })
      .where(eq(authIdentities.id, seeded.identityId));

    const attackIps = ['203.0.113.101', '203.0.113.102', '203.0.113.103'];
    for (let i = 0; i < attackIps.length; i += 1) {
      const res = await loginPost(
        makePostRequest(
          '/api/v1/auth/login',
          { email, password: `distributed-wrong-${i}` },
          attackIps[i]!,
        ),
      );
      // Ngay cả ở lần sai thứ 50 vẫn trả 401 INVALID_CREDENTIALS (chống User Enumeration).
      expect(res.status).toBe(401);
    }

    // Xác minh DB: status === 'locked' và failed_login_attempts === 50.
    const [lockedUser] = await db.select().from(users).where(eq(users.id, seeded.userId));
    const [lockedIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, seeded.identityId));
    expect(lockedUser?.status).toBe('locked');
    expect(lockedIdentity?.failedLoginAttempts).toBe(50);

    // Xác minh Audit Log có bản ghi `ACCOUNT_LOCKED`.
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.userId, seeded.userId));
    const lockAudit = logs.find((l) => l.action === 'ACCOUNT_LOCKED');
    expect(lockAudit).toBeDefined();
    expect(lockAudit?.ipAddress).toBe('203.0.113.103');

    // Xác minh email cảnh báo khóa tài khoản đã gửi kèm IP và đường dẫn Quên mật khẩu.
    const lockAlertEmail = emailCapture.messages.find((m) => m.subject.includes('tạm khóa'));
    expect(lockAlertEmail).toBeDefined();
    expect(lockAlertEmail?.to).toBe(email);
    expect(lockAlertEmail?.html).toContain('203.0.113.103');
    expect(lockAlertEmail?.html).toContain('/forgot-password');

    // Chủ tài khoản nhập đúng mật khẩu cũ -> bị từ chối `403 ACCOUNT_LOCKED`.
    const lockedLogin = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password }, '198.51.100.55'),
    );
    expect(lockedLogin.status).toBe(403);
    expect(((await lockedLogin.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_LOCKED',
    );

    // Mở khóa qua luồng Quên mật khẩu -> Đặt lại mật khẩu -> Đăng nhập thành công!
    const forgotRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', { email }, '198.51.100.55'),
    );
    expect(forgotRes.status).toBe(200);

    const resetEmail = emailCapture.messages.find((m) => m.subject.includes('đặt lại mật khẩu'));
    const tokenMatch = resetEmail?.text.match(/token=([A-Za-z0-9_-]+)/);
    expect(tokenMatch?.[1]).toBeTruthy();

    const resetRes = await resetPasswordPost(
      makePostRequest(
        '/api/v1/auth/reset-password',
        { token: tokenMatch![1], newPassword },
        '198.51.100.55',
      ),
    );
    expect(resetRes.status).toBe(200);

    const unlockedLogin = await loginPost(
      makePostRequest('/api/v1/auth/login', { email, password: newPassword }, '198.51.100.55'),
    );
    expect(unlockedLogin.status).toBe(200);
  });
});
