import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as changePasswordOtpPost } from '@/app/api/v1/auth/change-password/request-otp/route';
import { POST as changePasswordPost } from '@/app/api/v1/auth/change-password/route';
import { POST as verifyChangePasswordOtpPost } from '@/app/api/v1/auth/change-password/verify-otp/route';
import { POST as forgotPasswordPost } from '@/app/api/v1/auth/forgot-password/route';
import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { GET as meGet } from '@/app/api/v1/auth/me/route';
import { POST as refreshPost } from '@/app/api/v1/auth/refresh/route';
import { POST as resetPasswordPost } from '@/app/api/v1/auth/reset-password/route';
import { GET as sessionsGet } from '@/app/api/v1/auth/sessions/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword, verifyPassword } from '@/core/crypto/password';
import { hashTokenSha256 } from '@/core/crypto/token';
import { closeDatabasePool, getDb } from '@/core/db';
import {
  auditLogs,
  authIdentities,
  sessions,
  users,
  verificationTokens,
  type UserGender,
  type UserStatus,
} from '@/core/db/schema';
import { type EmailMessage, type EmailProvider } from '@/core/email';
import {
  AUTH_RATE_LIMITS,
  LoginBruteForceGuard,
  RateLimiter,
  closeRedisClient,
  getRedisClient,
} from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AUTH_MESSAGES,
  AuthRepository,
  AuthService,
  PASSWORD_CHANGE_OTP_MAX_ATTEMPTS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 1;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 240) + 10}`;
}

function makeUniqueEmail(label: string): string {
  return `m4-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tomato.test`;
}

function makeUniqueUsername(label: string): string {
  const safeLabel = label
    .replace(/[^a-z0-9_]/gi, '_')
    .slice(0, 10)
    .toLowerCase();
  return `${safeLabel}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class MemoryCaptureEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  getLatestFor(to: string): EmailMessage | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i]?.to === to) {
        return this.sent[i];
      }
    }
    return undefined;
  }

  getAllFor(to: string): EmailMessage[] {
    return this.sent.filter((msg) => msg.to === to);
  }
}

function extractResetTokenFromEmail(text: string): string {
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy token đặt lại mật khẩu trong nội dung email');
  }
  return decodeURIComponent(match[1]);
}

function extractSixDigitOtp(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy mã OTP 6 chữ số trong nội dung email');
  }
  return match[1];
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
  pwdTicket?: string;
}

function extractCookiesFromResponse(response: Response, previous: CookieJar = {}): CookieJar {
  const next: CookieJar = { ...previous };
  for (const header of response.headers.getSetCookie()) {
    const firstSegment = header.split(';')[0] ?? '';
    const eqIndex = firstSegment.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = firstSegment.slice(0, eqIndex).trim();
    const value = firstSegment.slice(eqIndex + 1).trim();
    const isCleared = /Max-Age=0/i.test(header) || value === '';

    if (name === 'tomato_at' || name === '__Host-tomato_at') {
      next.at = isCleared ? undefined : value;
    } else if (name === 'tomato_rt' || name === '__Host-tomato_rt') {
      next.rt = isCleared ? undefined : value;
    } else if (name === 'tomato_csrf' || name === '__Host-tomato_csrf') {
      next.csrf = isCleared ? undefined : value;
    } else if (name === 'tomato_pwd_ticket' || name === '__Host-tomato_pwd_ticket') {
      next.pwdTicket = isCleared ? undefined : value;
    }
  }
  return next;
}

function serializeCookieJar(jar: CookieJar): string {
  const parts: string[] = [];
  if (jar.at) {
    parts.push(`tomato_at=${jar.at}`);
  }
  if (jar.rt) {
    parts.push(`tomato_rt=${jar.rt}`);
  }
  if (jar.csrf) {
    parts.push(`tomato_csrf=${jar.csrf}`);
  }
  if (jar.pwdTicket) {
    parts.push(`tomato_pwd_ticket=${jar.pwdTicket}`);
  }
  return parts.join('; ');
}

function makePostRequest(
  pathname: string,
  options: {
    readonly body?: unknown;
    readonly jar?: CookieJar;
    readonly ip: string;
    readonly userAgent?: string;
    readonly includeCsrfHeader?: boolean;
  },
): Request {
  const origin = getTestOrigin();
  const headers: Record<string, string> = {
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'x-forwarded-for': options.ip,
    'user-agent':
      options.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.jar) {
    const cookieHeader = serializeCookieJar(options.jar);
    if (cookieHeader) {
      headers['cookie'] = cookieHeader;
    }
    if (options.includeCsrfHeader !== false && options.jar.csrf) {
      headers[CSRF_HEADER_NAME] = options.jar.csrf;
    }
  }

  return new Request(`${origin}${pathname}`, {
    method: 'POST',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function makeGetRequest(pathname: string, jar: CookieJar, ip: string): Request {
  const origin = getTestOrigin();
  const headers: Record<string, string> = {
    'x-forwarded-for': ip,
  };
  const cookieHeader = serializeCookieJar(jar);
  if (cookieHeader) {
    headers['cookie'] = cookieHeader;
  }
  return new Request(`${origin}${pathname}`, {
    method: 'GET',
    headers,
  });
}

async function seedUserWithPassword(params: {
  readonly email: string;
  readonly password: string;
  readonly status?: UserStatus;
  readonly fullName?: string;
  readonly username?: string;
  readonly gender?: UserGender;
  readonly failedLoginAttempts?: number;
}) {
  const db = getDb();
  const userId = generateUuidV7();
  const publicId = generatePublicId();
  const identityId = generateUuidV7();
  const { hash, pepperVersion } = await hashPassword(params.password);
  const now = new Date();
  const status = params.status ?? 'active';

  await db.insert(users).values({
    id: userId,
    publicId,
    username: params.username ?? makeUniqueUsername('m4user'),
    fullName: params.fullName ?? 'Nguyen Van M4',
    gender: params.gender ?? 'male',
    dateOfBirth: '1998-08-15',
    status,
    createdAt: now,
    updatedAt: now,
    deletedAt: status === 'deleted' ? now : null,
  });

  await db.insert(authIdentities).values({
    id: identityId,
    userId,
    provider: 'email_password',
    identifierNormalized: params.email.trim().normalize('NFKC').toLowerCase(),
    passwordHash: hash,
    pepperVersion,
    verifiedAt: status === 'pending_verification' ? null : now,
    failedLoginAttempts: params.failedLoginAttempts ?? 0,
    createdAt: now,
    updatedAt: now,
  });

  return { userId, publicId, identityId };
}

async function loginAsDevice(email: string, password: string, ip: string, userAgent: string) {
  const res = await loginPost(
    makePostRequest('/api/v1/auth/login', {
      body: { email, password },
      ip,
      userAgent,
      includeCsrfHeader: false,
    }),
  );
  expect(res.status).toBe(200);
  return extractCookiesFromResponse(res);
}

describe('Integration & Security M4: Quên mật khẩu, Đặt lại mật khẩu & Đổi mật khẩu (PostgreSQL + Redis thật)', () => {
  const createdUserIds: string[] = [];
  let emailCapture: MemoryCaptureEmailProvider;
  let testRateLimiter: RateLimiter;
  let currentClock: Date;

  beforeEach(() => {
    currentClock = new Date();
    emailCapture = new MemoryCaptureEmailProvider();

    const runSuffix = `${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    testRateLimiter = new RateLimiter(getRedisClient(), {
      keyPrefix: `tomato:rl:m4test:${runSuffix}`,
      now: () => currentClock.getTime(),
    });
    const testLoginProtection = new LoginBruteForceGuard(getRedisClient(), {
      keyPrefix: `tomato:bf:m4test:${runSuffix}`,
      now: () => currentClock.getTime(),
    });
    const repository = new AuthRepository();
    const auditLogService = new AuditLogService();
    const sessionService = new SessionService({
      repository,
      rateLimiter: testRateLimiter,
      auditLogService,
      now: () => currentClock,
    });
    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter: testRateLimiter,
      loginProtection: testLoginProtection,
      emailProvider: emailCapture,
      auditLogService,
      appUrl: getTestOrigin(),
      now: () => currentClock,
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
    await closeRedisClient();
    await closeDatabasePool();
  });

  it('Quên mật khẩu: xử lý đúng 404/403 theo trạng thái, yêu cầu token mới vô hiệu hóa token cũ, reset thu hồi MỌI phiên cũ, cấm tái sử dụng token và gửi email cảnh báo', async () => {
    const email = makeUniqueEmail('forgot-reset');
    const oldPassword = 'old strong passphrase 2026!';
    const newPassword = 'brand new reset passphrase 2027!';
    const seeded = await seedUserWithPassword({
      email,
      password: oldPassword,
      fullName: 'Tran Minh Khoi',
      username: makeUniqueUsername('khoi'),
      failedLoginAttempts: 4,
    });
    createdUserIds.push(seeded.userId);

    // Email không tồn tại -> 404 NOT_FOUND rõ ràng theo Phương án B (docs/01 Mục 4.4).
    const notFoundRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: makeUniqueEmail('missing') },
        ip: nextTestIp(),
      }),
    );
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const notFoundJson = (await notFoundRes.json()) as { error: { code: string; message: string } };
    expect(notFoundJson.error.code).toBe('NOT_FOUND');
    expect(notFoundJson.error.message).toBe(AUTH_MESSAGES.forgotPasswordEmailNotFound);

    // Tài khoản `deleted` -> 404, `pending_verification` -> 403 EMAIL_NOT_VERIFIED, `suspended` -> 403 ACCOUNT_SUSPENDED.
    const deletedEmail = makeUniqueEmail('deleted');
    const pendingEmail = makeUniqueEmail('pending');
    const suspendedEmail = makeUniqueEmail('suspended');
    const deletedSeeded = await seedUserWithPassword({
      email: deletedEmail,
      password: oldPassword,
      status: 'deleted',
    });
    const pendingSeeded = await seedUserWithPassword({
      email: pendingEmail,
      password: oldPassword,
      status: 'pending_verification',
    });
    const suspendedSeeded = await seedUserWithPassword({
      email: suspendedEmail,
      password: oldPassword,
      status: 'suspended',
    });
    createdUserIds.push(deletedSeeded.userId, pendingSeeded.userId, suspendedSeeded.userId);

    const deletedRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: deletedEmail },
        ip: nextTestIp(),
      }),
    );
    expect(deletedRes.status).toBe(404);

    const pendingRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: pendingEmail },
        ip: nextTestIp(),
      }),
    );
    expect(pendingRes.status).toBe(403);
    expect(((await pendingRes.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_NOT_VERIFIED',
    );

    const suspendedRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: suspendedEmail },
        ip: nextTestIp(),
      }),
    );
    expect(suspendedRes.status).toBe(403);
    expect(((await suspendedRes.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_SUSPENDED',
    );

    // Đăng nhập 2 thiết bị trước khi quên mật khẩu để xác nhận sau reset cả 2 đều bị thu hồi.
    const deviceA = await loginAsDevice(
      email,
      oldPassword,
      nextTestIp(),
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    );
    const deviceB = await loginAsDevice(
      email,
      oldPassword,
      nextTestIp(),
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1',
    );

    // 1. Yêu cầu token đặt lại lần 1.
    const forgot1Res = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: `  ${email.toUpperCase()}  ` },
        ip: nextTestIp(),
      }),
    );
    expect(forgot1Res.status).toBe(200);
    expect(forgot1Res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const email1 = emailCapture.getLatestFor(email);
    expect(email1).toBeDefined();
    const token1 = extractResetTokenFromEmail(email1!.text);
    // Token >= 256-bit (32 bytes base64url = 43 chars).
    expect(token1.length).toBeGreaterThanOrEqual(43);

    // Xác minh DB chỉ lưu SHA-256 hex, không lưu raw token.
    const db = getDb();
    const storedTokensAfter1 = await db
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.userId, seeded.userId),
          eq(verificationTokens.purpose, 'password_reset'),
        ),
      );
    expect(storedTokensAfter1).toHaveLength(1);
    expect(storedTokensAfter1[0]?.tokenHash).toBe(hashTokenSha256(token1));
    expect(storedTokensAfter1[0]?.consumedAt).toBeNull();

    // 2. Yêu cầu token đặt lại lần 2 -> phải vô hiệu hóa token #1 ngay lập tức.
    const forgot2Res = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email },
        ip: nextTestIp(),
      }),
    );
    expect(forgot2Res.status).toBe(200);
    const email2 = emailCapture.getLatestFor(email);
    const token2 = extractResetTokenFromEmail(email2!.text);
    expect(token2).not.toBe(token1);

    // Thử dùng token #1 đã bị vô hiệu hóa -> phải thất bại 400 TOKEN_INVALID.
    const useOldTokenRes = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: token1, newPassword },
        ip: nextTestIp(),
      }),
    );
    expect(useOldTokenRes.status).toBe(400);
    expect(((await useOldTokenRes.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );

    // Thử đặt mật khẩu trùng email bằng token #2 -> bị chặn 400 VALIDATION_ERROR nhưng KHÔNG hủy token #2.
    const weakContextRes = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: token2, newPassword: `prefix-${email}-suffix` },
        ip: nextTestIp(),
      }),
    );
    expect(weakContextRes.status).toBe(400);
    expect(((await weakContextRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );

    // 3. Đặt lại mật khẩu thành công bằng token #2.
    const resetIp = nextTestIp();
    const resetRes = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: token2, newPassword },
        ip: resetIp,
        userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Firefox/132.0',
      }),
    );
    expect(resetRes.status).toBe(200);
    expect(resetRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const resetJson = (await resetRes.json()) as { reset: boolean; message: string };
    expect(resetJson.reset).toBe(true);
    // Response xóa cookie phiên cũ trên trình duyệt.
    expect(resetRes.headers.getSetCookie().some((c) => /Max-Age=0/i.test(c))).toBe(true);

    // 4. Tái sử dụng token #2 sau khi đã reset -> thất bại 400 TOKEN_INVALID.
    const replayToken2Res = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: token2, newPassword: 'another safe passphrase 2028!' },
        ip: nextTestIp(),
      }),
    );
    expect(replayToken2Res.status).toBe(400);
    expect(((await replayToken2Res.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );

    // 5. Mọi phiên cũ trên Device A và Device B đều không thể gọi /me hoặc /refresh được nữa.
    for (const oldJar of [deviceA, deviceB]) {
      const meRes = await meGet(makeGetRequest('/api/v1/auth/me', oldJar, nextTestIp()));
      expect(meRes.status).toBe(401);

      const refreshRes = await refreshPost(
        makePostRequest('/api/v1/auth/refresh', {
          jar: oldJar,
          ip: nextTestIp(),
        }),
      );
      expect(refreshRes.status).toBe(401);
    }

    // Kiểm tra DB: password_hash + pepper_version đã cập nhật, failed_login_attempts = 0, mọi session bị revoke.
    const [updatedIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, seeded.identityId));
    expect(updatedIdentity?.failedLoginAttempts).toBe(0);
    expect(updatedIdentity?.pepperVersion).toBe(getEnv().CURRENT_PEPPER_VERSION);
    const verifyNew = await verifyPassword(
      newPassword,
      updatedIdentity!.passwordHash!,
      updatedIdentity!.pepperVersion,
    );
    expect(verifyNew.valid).toBe(true);

    const userSessions = await db.select().from(sessions).where(eq(sessions.userId, seeded.userId));
    expect(userSessions.length).toBeGreaterThanOrEqual(2);
    expect(
      userSessions.every((s) => s.revokedAt !== null && s.revokeReason === 'password_reset'),
    ).toBe(true);

    // Kiểm tra Audit Log `PASSWORD_RESET` và email cảnh báo bảo mật (kèm IP + thiết bị).
    const [resetAudit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, seeded.userId), eq(auditLogs.action, 'PASSWORD_RESET')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(resetAudit).toBeDefined();
    expect(JSON.stringify(resetAudit?.metadata)).not.toContain(token2);
    expect(JSON.stringify(resetAudit?.metadata)).not.toContain(newPassword);

    const alertEmail = emailCapture.getLatestFor(email);
    expect(alertEmail?.subject).toContain('đặt lại');
    expect(alertEmail?.text).toContain(resetIp);
    expect(alertEmail?.text).toContain('Firefox 132 / Linux');

    // Mật khẩu cũ không đăng nhập được nữa, mật khẩu mới đăng nhập thành công.
    const oldLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: oldPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: newPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(newLoginRes.status).toBe(200);
  });

  it('Quên mật khẩu: tài khoản đang bị locked (50 lần sai) được mở khóa lại thành active sau khi reset và token quá 15 phút bị từ chối TOKEN_EXPIRED', async () => {
    const email = makeUniqueEmail('locked-unlock');
    const oldPassword = 'locked account passphrase 2026!';
    const newPassword = 'unlocked account passphrase 2027!';
    const seeded = await seedUserWithPassword({
      email,
      password: oldPassword,
      status: 'locked',
      failedLoginAttempts: 50,
    });
    createdUserIds.push(seeded.userId);

    // Trước khi reset: tài khoản `locked` đăng nhập đúng mật khẩu cũ vẫn bị 403 ACCOUNT_LOCKED.
    const lockedLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: oldPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(lockedLoginRes.status).toBe(403);
    expect(((await lockedLoginRes.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_LOCKED',
    );

    // Yêu cầu token #1 rồi tua đồng hồ vượt 15 phút -> kiểm tra TOKEN_EXPIRED.
    const forgotExpiredRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email },
        ip: nextTestIp(),
      }),
    );
    expect(forgotExpiredRes.status).toBe(200);
    const expiredToken = extractResetTokenFromEmail(emailCapture.getLatestFor(email)!.text);

    currentClock = new Date(currentClock.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1000);
    const expiredAttemptRes = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: expiredToken, newPassword },
        ip: nextTestIp(),
      }),
    );
    expect(expiredAttemptRes.status).toBe(400);
    expect(((await expiredAttemptRes.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_EXPIRED',
    );

    // Yêu cầu token #2 mới và reset trong hạn 15 phút -> mở khóa `locked -> active`, `failed_login_attempts = 0`.
    const forgotFreshRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email },
        ip: nextTestIp(),
      }),
    );
    expect(forgotFreshRes.status).toBe(200);
    const freshToken = extractResetTokenFromEmail(emailCapture.getLatestFor(email)!.text);

    const resetRes = await resetPasswordPost(
      makePostRequest('/api/v1/auth/reset-password', {
        body: { token: freshToken, newPassword },
        ip: nextTestIp(),
      }),
    );
    expect(resetRes.status).toBe(200);

    const db = getDb();
    const [updatedUser] = await db.select().from(users).where(eq(users.id, seeded.userId));
    const [updatedIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, seeded.identityId));
    expect(updatedUser?.status).toBe('active');
    expect(updatedIdentity?.failedLoginAttempts).toBe(0);

    // Đăng nhập được bình thường với mật khẩu mới.
    const unlockedLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: newPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(unlockedLoginRes.status).toBe(200);
  });

  it('Quên mật khẩu: Rate Limit chặt 3 lần / 15 phút theo IP và theo Email -> lần thứ 4 bị chặn 429', async () => {
    const email = makeUniqueEmail('forgot-rl');
    const seeded = await seedUserWithPassword({
      email,
      password: 'rate limit test passphrase 2026!',
    });
    createdUserIds.push(seeded.userId);

    // 3 lần hợp lệ từ 3 IP khác nhau cho cùng 1 email -> lần 4 bị chặn bởi hạn mức Email (3/15p).
    for (let i = 0; i < 3; i += 1) {
      const okRes = await forgotPasswordPost(
        makePostRequest('/api/v1/auth/forgot-password', {
          body: { email },
          ip: nextTestIp(),
        }),
      );
      expect(okRes.status).toBe(200);
    }

    const fourthByEmailRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email },
        ip: nextTestIp(),
      }),
    );
    expect(fourthByEmailRes.status).toBe(429);
    expect(Number(fourthByEmailRes.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Kiểm tra thêm giới hạn 3 lần / 15 phút theo IP với các email khác nhau.
    const sharedIp = nextTestIp();
    for (let i = 0; i < 3; i += 1) {
      const res = await forgotPasswordPost(
        makePostRequest('/api/v1/auth/forgot-password', {
          body: { email: makeUniqueEmail(`ip-rl-${i}`) },
          ip: sharedIp,
        }),
      );
      expect(res.status).toBe(404);
    }
    const fourthByIpRes = await forgotPasswordPost(
      makePostRequest('/api/v1/auth/forgot-password', {
        body: { email: makeUniqueEmail('ip-rl-4') },
        ip: sharedIp,
      }),
    );
    expect(fourthByIpRes.status).toBe(429);
  });

  it('Đổi mật khẩu: chặn sai mật khẩu hiện tại, chặn trùng mật khẩu cũ, cooldown 60s + tối đa 5 lần sai OTP, thu hồi thiết bị khác và xoay vòng phiên hiện tại', async () => {
    const email = makeUniqueEmail('change-pw');
    const currentPassword = 'current account passphrase 2026!';
    const newPassword = 'updated account passphrase 2027!';
    const seeded = await seedUserWithPassword({
      email,
      password: currentPassword,
      fullName: 'Le Minh Tuan',
      username: makeUniqueUsername('tuan'),
    });
    createdUserIds.push(seeded.userId);

    // Đăng nhập trên 2 thiết bị: Device A (sẽ thực hiện đổi mật khẩu) và Device B (thiết bị khác).
    const deviceAIp = nextTestIp();
    const deviceAOldJar = await loginAsDevice(
      email,
      currentPassword,
      deviceAIp,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    );
    const deviceBJar = await loginAsDevice(
      email,
      currentPassword,
      nextTestIp(),
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.1 Safari/605.1.15',
    );

    // 1. Yêu cầu OTP đổi mật khẩu -> 200 và áp dụng cooldown 60 giây.
    const otp1Res = await changePasswordOtpPost(
      makePostRequest('/api/v1/auth/change-password/request-otp', {
        jar: deviceAOldJar,
        ip: deviceAIp,
      }),
    );
    expect(otp1Res.status).toBe(200);
    expect(otp1Res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const otp1Json = (await otp1Res.json()) as {
      cooldownSeconds: number;
      expiresInMinutes: number;
    };
    expect(otp1Json.cooldownSeconds).toBe(60);
    expect(otp1Json.expiresInMinutes).toBe(10);

    const otpEmail1 = emailCapture.getLatestFor(email);
    expect(otpEmail1).toBeDefined();
    expect(otpEmail1!.subject).not.toMatch(/\d{6}/);
    const otpCode1 = extractSixDigitOtp(otpEmail1!.text);

    // Gọi lại request-otp ngay trong vòng 60s -> bị chặn 429 cooldown.
    const cooldownBlockedRes = await changePasswordOtpPost(
      makePostRequest('/api/v1/auth/change-password/request-otp', {
        jar: deviceAOldJar,
        ip: deviceAIp,
      }),
    );
    expect(cooldownBlockedRes.status).toBe(429);
    expect(Number(cooldownBlockedRes.headers.get('Retry-After'))).toBeGreaterThan(0);

    // 2. Cố nhảy thẳng sang Bước 2 khi chưa xác minh OTP Bước 1 -> bị chặn 403 TOKEN_INVALID.
    const bypassStep1Res = await changePasswordPost(
      makePostRequest('/api/v1/auth/change-password', {
        body: {
          currentPassword,
          newPassword,
        },
        jar: deviceAOldJar,
        ip: deviceAIp,
      }),
    );
    expect(bypassStep1Res.status).toBe(403);
    expect(((await bypassStep1Res.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );

    // 3. Nhập sai OTP 5 lần liên tiếp ở Bước 1b -> mã OTP #1 bị hủy ngay, kể cả nhập đúng otpCode1 sau đó cũng thất bại.
    const wrongOtp = otpCode1 === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= PASSWORD_CHANGE_OTP_MAX_ATTEMPTS; attempt += 1) {
      const wrongOtpRes = await verifyChangePasswordOtpPost(
        makePostRequest('/api/v1/auth/change-password/verify-otp', {
          body: { otpCode: wrongOtp },
          jar: deviceAOldJar,
          ip: nextTestIp(),
        }),
      );
      expect(wrongOtpRes.status).toBe(400);
      expect(((await wrongOtpRes.json()) as { error: { code: string } }).error.code).toBe(
        'TOKEN_INVALID',
      );
    }

    // Nhập đúng otpCode1 sau khi đã quá 5 lần sai -> vẫn bị từ chối vì OTP đã bị hủy.
    const exhaustedOtpRes = await verifyChangePasswordOtpPost(
      makePostRequest('/api/v1/auth/change-password/verify-otp', {
        body: { otpCode: otpCode1 },
        jar: deviceAOldJar,
        ip: nextTestIp(),
      }),
    );
    expect(exhaustedOtpRes.status).toBe(400);
    expect(((await exhaustedOtpRes.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );

    // 4. Mô phỏng hết cửa sổ cooldown 60 giây trên Redis thật, xin OTP #2 mới và xác minh Bước 1b nhận HttpOnly ticket.
    await testRateLimiter.reset(
      `change-password-otp:cooldown:${seeded.userId}`,
      AUTH_RATE_LIMITS.changePasswordOtpCooldown,
    );
    currentClock = new Date(currentClock.getTime() + 61 * 1000);
    const otp2Res = await changePasswordOtpPost(
      makePostRequest('/api/v1/auth/change-password/request-otp', {
        jar: deviceAOldJar,
        ip: deviceAIp,
      }),
    );
    expect(otp2Res.status).toBe(200);
    const otpCode2 = extractSixDigitOtp(emailCapture.getLatestFor(email)!.text);

    const verifyOtp2Res = await verifyChangePasswordOtpPost(
      makePostRequest('/api/v1/auth/change-password/verify-otp', {
        body: { otpCode: otpCode2 },
        jar: deviceAOldJar,
        ip: deviceAIp,
      }),
    );
    expect(verifyOtp2Res.status).toBe(200);
    expect(verifyOtp2Res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const verifyOtp2Json = (await verifyOtp2Res.json()) as {
      verified: boolean;
      expiresInMinutes: number;
    };
    expect(verifyOtp2Json.verified).toBe(true);
    expect(verifyOtp2Json.expiresInMinutes).toBe(10);
    // Tuyệt đối không trả raw ticket trong JSON body; chỉ gửi qua HttpOnly cookie.
    expect(JSON.stringify(verifyOtp2Json)).not.toContain('ticket');

    const deviceAWithTicketJar = extractCookiesFromResponse(verifyOtp2Res, deviceAOldJar);
    expect(deviceAWithTicketJar.pwdTicket).toBeDefined();

    // 5. Bước 2: nhập mật khẩu mới trùng mật khẩu cũ -> bị chặn 400 VALIDATION_ERROR.
    const samePassRes = await changePasswordPost(
      makePostRequest('/api/v1/auth/change-password', {
        body: {
          currentPassword,
          newPassword: currentPassword,
        },
        jar: deviceAWithTicketJar,
        ip: deviceAIp,
      }),
    );
    expect(samePassRes.status).toBe(400);
    expect(((await samePassRes.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );

    // 6. Bước 2: nhập sai mật khẩu hiện tại -> bị chặn 400 INVALID_CREDENTIALS (vẫn còn lượt thử trên ticket).
    const wrongCurrentRes = await changePasswordPost(
      makePostRequest('/api/v1/auth/change-password', {
        body: {
          currentPassword: 'wrong current passphrase 2026!',
          newPassword,
        },
        jar: deviceAWithTicketJar,
        ip: deviceAIp,
      }),
    );
    expect(wrongCurrentRes.status).toBe(400);
    expect(((await wrongCurrentRes.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CREDENTIALS',
    );

    // 7. Bước 2: nhập đúng mật khẩu hiện tại và mật khẩu mới -> đổi mật khẩu thành công, xóa cookie ticket, xoay vòng phiên.
    const changeIp = nextTestIp();
    const changeRes = await changePasswordPost(
      makePostRequest('/api/v1/auth/change-password', {
        body: {
          currentPassword,
          newPassword,
        },
        jar: deviceAWithTicketJar,
        ip: changeIp,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131.0.0.0',
      }),
    );
    expect(changeRes.status).toBe(200);
    expect(changeRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const changeJson = (await changeRes.json()) as {
      changed: boolean;
      revokedOtherSessionsCount: number;
      message: string;
    };
    expect(changeJson.changed).toBe(true);
    expect(changeJson.revokedOtherSessionsCount).toBe(1);
    // Tuyệt đối không rò token thô trong JSON body.
    expect(JSON.stringify(changeJson)).not.toContain('accessToken');
    expect(JSON.stringify(changeJson)).not.toContain('refreshToken');

    const deviceANewJar = extractCookiesFromResponse(changeRes, deviceAWithTicketJar);
    expect(deviceANewJar.pwdTicket).toBeUndefined();
    expect(deviceANewJar.at).toBeDefined();
    expect(deviceANewJar.rt).toBeDefined();
    expect(deviceANewJar.csrf).toBeDefined();
    // Xoay vòng phiên chống Session Fixation: toàn bộ AT, RT, CSRF phải là giá trị mới hoàn toàn.
    expect(deviceANewJar.at).not.toBe(deviceAOldJar.at);
    expect(deviceANewJar.rt).not.toBe(deviceAOldJar.rt);
    expect(deviceANewJar.csrf).not.toBe(deviceAOldJar.csrf);

    // 6. Thiết bị khác (Device B) bị đá ra hoàn toàn (cả /me lẫn /refresh trả 401).
    const deviceBMe = await meGet(makeGetRequest('/api/v1/auth/me', deviceBJar, nextTestIp()));
    expect(deviceBMe.status).toBe(401);
    const deviceBRefresh = await refreshPost(
      makePostRequest('/api/v1/auth/refresh', {
        jar: deviceBJar,
        ip: nextTestIp(),
      }),
    );
    expect(deviceBRefresh.status).toBe(401);

    // 7. Cookie CŨ của chính Device A cũng đã bị thu hồi (chống session fixation).
    const deviceAOldMe = await meGet(
      makeGetRequest('/api/v1/auth/me', deviceAOldJar, nextTestIp()),
    );
    expect(deviceAOldMe.status).toBe(401);
    const deviceAOldRefresh = await refreshPost(
      makePostRequest('/api/v1/auth/refresh', {
        jar: deviceAOldJar,
        ip: nextTestIp(),
      }),
    );
    expect(deviceAOldRefresh.status).toBe(401);

    // 8. Phiên MỚI của Device A tiếp tục sử dụng bình thường trên /me, /sessions (chỉ còn 1 phiên) và /refresh!
    const deviceANewMe = await meGet(
      makeGetRequest('/api/v1/auth/me', deviceANewJar, nextTestIp()),
    );
    expect(deviceANewMe.status).toBe(200);

    const deviceASessionsRes = await sessionsGet(
      makeGetRequest('/api/v1/auth/sessions', deviceANewJar, nextTestIp()),
    );
    expect(deviceASessionsRes.status).toBe(200);
    const sessionsJson = (await deviceASessionsRes.json()) as {
      sessions: readonly { public_id: string; isCurrent: boolean }[];
    };
    expect(sessionsJson.sessions).toHaveLength(1);
    expect(sessionsJson.sessions[0]?.isCurrent).toBe(true);

    const deviceANewRefresh = await refreshPost(
      makePostRequest('/api/v1/auth/refresh', {
        jar: deviceANewJar,
        ip: nextTestIp(),
      }),
    );
    expect(deviceANewRefresh.status).toBe(200);

    // 9. Kiểm tra Audit Log `PASSWORD_CHANGED` và email thông báo bảo mật.
    const db = getDb();
    const [changedAudit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, seeded.userId), eq(auditLogs.action, 'PASSWORD_CHANGED')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(changedAudit).toBeDefined();
    expect(JSON.stringify(changedAudit?.metadata)).not.toContain(currentPassword);
    expect(JSON.stringify(changedAudit?.metadata)).not.toContain(newPassword);
    expect(JSON.stringify(changedAudit?.metadata)).not.toContain(otpCode2);

    const alertEmail = emailCapture.getLatestFor(email);
    expect(alertEmail?.subject).toContain('thay đổi');
    expect(alertEmail?.text).toContain(changeIp);
    expect(alertEmail?.text).toContain('Edge 131 / Windows 10/11');

    // 10. Đăng nhập lại: mật khẩu cũ thất bại, mật khẩu mới thành công.
    const oldLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: currentPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await loginPost(
      makePostRequest('/api/v1/auth/login', {
        body: { email, password: newPassword },
        ip: nextTestIp(),
        includeCsrfHeader: false,
      }),
    );
    expect(newLoginRes.status).toBe(200);
  }, 15_000);
});
