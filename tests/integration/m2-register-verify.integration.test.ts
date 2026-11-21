import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as registerPost } from '@/app/api/v1/auth/register/route';
import { POST as resendPost } from '@/app/api/v1/auth/resend-verification/route';
import { POST as verifyPost } from '@/app/api/v1/auth/verify-email/route';
import { getCaptchaProvider } from '@/core/captcha';
import { getEnv } from '@/core/config/env';
import { verifyPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { auditLogs, authIdentities, users, verificationTokens } from '@/core/db/schema';
import {
  closeEmailProvider,
  getEmailProvider,
  type EmailMessage,
  type EmailProvider,
} from '@/core/email';
import { AUTH_RATE_LIMITS, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AUTH_MESSAGES,
  AuthRepository,
  AuthService,
  PENDING_VERIFICATION_EXPIRY_MS,
  resetAuthServiceForTesting,
  setAuthServiceForTesting,
} from '@/modules/auth';

const MAILPIT_API_BASE = 'http://127.0.0.1:8025';

function getTestOrigin(): string {
  // Đọc Origin hợp lệ từ cấu hình thực tế để đồng bộ cả CI (`http://127.0.0.1:3000`) lẫn `.env.local` (`http://localhost:3000`).
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 1;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 240) + 10}`;
}

function makeUniqueEmail(label: string): string {
  return `m2-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tomato.test`;
}

function makeAuthRequest(pathname: string, body: unknown, ip: string): Request {
  const origin = getTestOrigin();
  return new Request(`${origin}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'x-forwarded-for': ip,
      'user-agent': 'Vitest-M2-Integration/1.0',
    },
    body: JSON.stringify(body),
  });
}

function extractSixDigitOtp(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy mã OTP 6 chữ số trong nội dung email');
  }
  return match[1];
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

describe('Integration & Security M2: Đăng ký & Xác minh Email (PostgreSQL + Redis + Mailpit)', () => {
  const testRunPrefix = `tomato:m2:itest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const createdEmails = new Set<string>();
  const usedRateLimitIps = new Set<string>();
  let testClockMs = Date.now();
  let emailSpy: MemoryCaptureEmailProvider;
  let testRateLimiter: RateLimiter;

  function installIsolatedAuthService(options?: { readonly useRealSmtp?: boolean }) {
    const db = getDb();
    const redis = getRedisClient();
    testRateLimiter = new RateLimiter(redis, {
      keyPrefix: testRunPrefix,
      now: () => testClockMs,
    });
    emailSpy = new MemoryCaptureEmailProvider();

    const service = new AuthService({
      repository: new AuthRepository(() => db),
      rateLimiter: testRateLimiter,
      emailProvider: options?.useRealSmtp ? getEmailProvider() : emailSpy,
      captchaProvider: getCaptchaProvider(),
      auditLogService: new AuditLogService(() => db),
      appUrl: getTestOrigin(),
      now: () => new Date(testClockMs),
    });

    setAuthServiceForTesting(service);
    return service;
  }

  beforeEach(() => {
    testClockMs = Date.now();
    installIsolatedAuthService();
  });

  afterAll(async () => {
    resetAuthServiceForTesting();
    const db = getDb();
    const redis = getRedisClient();

    for (const email of createdEmails) {
      const rows = await db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifierNormalized, email));

      for (const row of rows) {
        await db.delete(auditLogs).where(eq(auditLogs.userId, row.userId));
        await db.delete(users).where(eq(users.id, row.userId));
      }

      const limiter = new RateLimiter(redis, {
        keyPrefix: testRunPrefix,
        now: () => testClockMs,
      });
      await limiter.reset(`resend:cooldown:${email}`, AUTH_RATE_LIMITS.resendVerificationCooldown);
      await limiter.reset(`resend:email15m:${email}`, AUTH_RATE_LIMITS.resendVerificationByEmail);
      await limiter.reset(
        `resend:email1h:${email}`,
        AUTH_RATE_LIMITS.resendVerificationHourlyByEmail,
      );
      await limiter.reset(`register:dup-notice:${email}`, {
        windowSeconds: 15 * 60,
        strategy: 'fixed_window',
      });
    }

    for (const ip of usedRateLimitIps) {
      const limiter = new RateLimiter(redis, {
        keyPrefix: testRunPrefix,
        now: () => testClockMs,
      });
      await limiter.reset(`register:ip:${ip}`, AUTH_RATE_LIMITS.registerByIp);
      await limiter.reset(`verify-email:ip:${ip}`, AUTH_RATE_LIMITS.verifyEmailByIp);
      await limiter.reset(`resend:ip:${ip}`, AUTH_RATE_LIMITS.resendVerificationByIp);
    }

    await Promise.all([closeDatabasePool(), closeRedisClient(), closeEmailProvider()]);
  });

  it('Luồng chuẩn end-to-end (SMTP thật tới Mailpit): Đăng ký -> Nhận OTP qua Mailpit -> Xác minh OTP -> Tài khoản active + Audit Log sạch', async () => {
    installIsolatedAuthService({ useRealSmtp: true });

    const email = makeUniqueEmail('happy-mailpit');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);
    const rawPassword = 'Mật khẩu an toàn cho kiểm thử Mailpit 2026!';

    const regRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email: `  ${email.toUpperCase()}  `,
          password: rawPassword,
          displayName: 'Nguyễn Minh Anh',
          dateOfBirth: '1999-08-20',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );

    expect(regRes.status).toBe(202);
    expect(regRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const regJson = (await regRes.json()) as Record<string, unknown>;
    expect(regJson).toEqual({
      message: AUTH_MESSAGES.registerAccepted,
      verificationRequired: true,
    });
    // Tuyệt đối không lộ id hay public_id trong response đăng ký.
    expect(regJson).not.toHaveProperty('id');
    expect(regJson).not.toHaveProperty('public_id');
    expect(regJson).not.toHaveProperty('publicId');

    // Kiểm tra email thực sự đã tới Mailpit (cổng HTTP 8025) và trích xuất OTP 6 số.
    const mailpitSearchRes = await fetch(
      `${MAILPIT_API_BASE}/api/v1/search?query=${encodeURIComponent(email)}`,
    );
    expect(mailpitSearchRes.ok).toBe(true);
    const searchData = (await mailpitSearchRes.json()) as {
      messages?: { ID: string; Subject: string }[];
    };
    expect(searchData.messages && searchData.messages.length).toBeGreaterThanOrEqual(1);
    const latestMessageId = searchData.messages![0]!.ID;

    const mailpitMsgRes = await fetch(`${MAILPIT_API_BASE}/api/v1/message/${latestMessageId}`);
    expect(mailpitMsgRes.ok).toBe(true);
    const mailpitMsg = (await mailpitMsgRes.json()) as { Text: string; HTML: string };
    expect(mailpitMsg.HTML).toContain('Nguyễn Minh Anh');
    const otpCode = extractSixDigitOtp(mailpitMsg.Text);

    // Kiểm tra trạng thái DB trước khi xác minh: pending_verification.
    const db = getDb();
    const [identityBefore] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    expect(identityBefore).toBeDefined();
    expect(identityBefore!.verifiedAt).toBeNull();
    const [userBefore] = await db.select().from(users).where(eq(users.id, identityBefore!.userId));
    expect(userBefore?.status).toBe('pending_verification');

    // Gửi POST /api/v1/auth/verify-email với mã OTP đúng.
    const verifyRes = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode }, ip),
    );
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const verifyJson = (await verifyRes.json()) as { verified: boolean; message: string };
    expect(verifyJson).toEqual({
      verified: true,
      message: AUTH_MESSAGES.emailVerified,
    });

    // Xác nhận trạng thái DB sau khi xác minh: active, verified_at != null, consumed_at != null.
    const [userAfter] = await db.select().from(users).where(eq(users.id, identityBefore!.userId));
    expect(userAfter?.status).toBe('active');
    const [identityAfter] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, identityBefore!.id));
    expect(identityAfter?.verifiedAt).not.toBeNull();

    const tokensAfter = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.userId, identityBefore!.userId));
    expect(tokensAfter).toHaveLength(1);
    expect(tokensAfter[0]?.consumedAt).not.toBeNull();

    // Xác nhận Audit Log ghi đủ REGISTER + EMAIL_VERIFIED và không chứa mật khẩu/OTP.
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, identityBefore!.userId));
    const actions = logs.map((log) => log.action);
    expect(actions).toContain('REGISTER');
    expect(actions).toContain('EMAIL_VERIFIED');
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(rawPassword);
    expect(serializedLogs).not.toContain(otpCode);

    // Bảo mật: tái sử dụng mã OTP đã xác minh phải thất bại.
    const reuseRes = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode }, ip),
    );
    expect(reuseRes.status).toBe(400);
    const reuseJson = (await reuseRes.json()) as { error: { code: string } };
    expect(reuseJson.error.code).toBe('TOKEN_INVALID');
  });

  it('Bảo mật: chặn tuổi < 13 và chặn mật khẩu < 12 hoặc > 128 ký tự (không cắt ngắn)', async () => {
    const db = getDb();

    // 1. Dưới 13 tuổi
    const underageEmail = makeUniqueEmail('underage');
    createdEmails.add(underageEmail);
    const ip1 = nextTestIp();
    usedRateLimitIps.add(ip1);
    const underageDob = new Date(testClockMs);
    underageDob.setUTCFullYear(underageDob.getUTCFullYear() - 12);
    const underageIso = underageDob.toISOString().slice(0, 10);

    const underageRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email: underageEmail,
          password: 'cụm mật khẩu an toàn đủ dài 2026',
          displayName: 'Bạn Nhỏ',
          dateOfBirth: underageIso,
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip1,
      ),
    );
    expect(underageRes.status).toBe(400);
    const underageJson = (await underageRes.json()) as {
      error: { code: string; details: { field?: string }[] };
    };
    expect(underageJson.error.code).toBe('VALIDATION_ERROR');
    expect(underageJson.error.details.some((d) => d.field === 'dateOfBirth')).toBe(true);

    // 2. Mật khẩu < 12 ký tự
    const shortPassEmail = makeUniqueEmail('short-pass');
    createdEmails.add(shortPassEmail);
    const shortRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email: shortPassEmail,
          password: '11charsOnly',
          displayName: 'Người Dùng',
          dateOfBirth: '1998-01-01',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip1,
      ),
    );
    expect(shortRes.status).toBe(400);

    // 3. Mật khẩu > 128 ký tự (tuyệt đối không tự cắt ngắn xuống 128)
    const longPassEmail = makeUniqueEmail('long-pass');
    createdEmails.add(longPassEmail);
    const longRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email: longPassEmail,
          password: `Ab3!`.repeat(32) + 'X', // 129 ký tự
          displayName: 'Người Dùng',
          dateOfBirth: '1998-01-01',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip1,
      ),
    );
    expect(longRes.status).toBe(400);

    // Đảm bảo không có tài khoản nào được tạo trong DB.
    for (const blockedEmail of [underageEmail, shortPassEmail, longPassEmail]) {
      const rows = await db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.identifierNormalized, blockedEmail));
      expect(rows).toHaveLength(0);
    }
  });

  it('Bảo mật: nhập sai OTP 5 lần hủy OTP ngay lập tức (lần thứ 6 nhập đúng OTP cũ vẫn thất bại)', async () => {
    const email = makeUniqueEmail('otp-5-strikes');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const regRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: 'cụm mật khẩu rất an toàn 2026!',
          displayName: 'Tester OTP',
          dateOfBirth: '1997-04-12',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(regRes.status).toBe(202);

    const realOtp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);
    const wrongOtp = realOtp === '000000' ? '111111' : '000000';

    // Nhập sai liên tiếp 5 lần.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await verifyPost(
        makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: wrongOtp }, ip),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('TOKEN_INVALID');
      if (attempt === 5) {
        expect(body.error.message).toContain('đã bị hủy');
      }
    }

    // Kiểm tra DB: attempt_count === 5 và consumed_at != null.
    const db = getDb();
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    const [tokenRow] = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.userId, identity!.userId));
    expect(tokenRow?.attemptCount).toBe(5);
    expect(tokenRow?.consumedAt).not.toBeNull();

    // Thử lại với đúng mã OTP thật sau khi đã bị hủy -> phải thất bại.
    const sixthRes = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: realOtp }, ip),
    );
    expect(sixthRes.status).toBe(400);
    const [userRow] = await db.select().from(users).where(eq(users.id, identity!.userId));
    expect(userRow?.status).toBe('pending_verification');
  });

  it('Bảo mật: mã OTP quá hạn 15 phút bị từ chối với TOKEN_EXPIRED', async () => {
    const email = makeUniqueEmail('otp-expired');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const regRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: 'cụm mật khẩu rất an toàn 2026!',
          displayName: 'Expired OTP',
          dateOfBirth: '1997-04-12',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(regRes.status).toBe(202);
    const realOtp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);

    // Tua đồng hồ thêm 15 phút 1 giây.
    testClockMs += 15 * 60 * 1000 + 1000;

    const verifyRes = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: realOtp }, ip),
    );
    expect(verifyRes.status).toBe(400);
    const body = (await verifyRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('Bảo mật: đăng ký trùng email đã active không lộ lỗi tồn tại và gửi email nhắc nhở riêng', async () => {
    const email = makeUniqueEmail('dup-active');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);
    const originalPassword = 'Mật khẩu ban đầu của chủ tài khoản 2026';

    // Bước 1: Đăng ký và xác minh để tài khoản chuyển sang `active`.
    const firstReg = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: originalPassword,
          displayName: 'Chủ Sở Hữu',
          dateOfBirth: '1995-07-07',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(firstReg.status).toBe(202);
    const firstBody = await firstReg.json();

    const otp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);
    const verified = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: otp }, ip),
    );
    expect(verified.status).toBe(200);

    // Bước 2: Người khác cố đăng ký trùng email đã active.
    const dupReg = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: 'Mật khẩu của kẻ cố đăng ký trùng 2026',
          displayName: 'Kẻ Thử Trùng',
          dateOfBirth: '2001-01-01',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );

    // Trạng thái HTTP & payload JSON phải GIỐNG HỆT lần đăng ký mới.
    expect(dupReg.status).toBe(firstReg.status);
    expect(await dupReg.json()).toEqual(firstBody);

    // Email nhắc nhở được gửi riêng tới chủ tài khoản.
    const allMails = emailSpy.getAllFor(email);
    expect(allMails).toHaveLength(2);
    expect(allMails[1]?.subject).toContain('Thông báo yêu cầu đăng ký');

    // Mật khẩu & trạng thái của chủ tài khoản không hề bị thay đổi.
    const db = getDb();
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    const checkOriginal = await verifyPassword(
      originalPassword,
      identity!.passwordHash!,
      identity!.pepperVersion,
    );
    expect(checkOriginal.valid).toBe(true);
  });

  it('Bảo mật (Race Condition): 2 request đăng ký trùng đồng thời (Promise.all) không gây lỗi 500 và chỉ tạo đúng 1 tài khoản', async () => {
    const email = makeUniqueEmail('race-cond');
    createdEmails.add(email);
    const ip1 = nextTestIp();
    const ip2 = nextTestIp();
    usedRateLimitIps.add(ip1);
    usedRateLimitIps.add(ip2);

    const payload = {
      email,
      password: 'Cụm mật khẩu mạnh chống race condition 2026',
      displayName: 'Race User',
      dateOfBirth: '1996-06-15',
      acceptedTerms: true,
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
    };

    const [resA, resB] = await Promise.all([
      registerPost(makeAuthRequest('/api/v1/auth/register', payload, ip1)),
      registerPost(makeAuthRequest('/api/v1/auth/register', payload, ip2)),
    ]);

    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    expect(resA.status).not.toBe(500);
    expect(resB.status).not.toBe(500);

    const db = getDb();
    const identities = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    expect(identities).toHaveLength(1);
  });

  it('Resend OTP: ép cooldown 60s, vô hiệu hóa OTP cũ khi cấp OTP mới và chặn khi vượt 5 lần/giờ', async () => {
    // Căn chỉnh đồng hồ test về đầu một khung giờ tròn (+10s) để kiểm thử cửa sổ 1 giờ hoàn toàn tất định.
    testClockMs = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 10_000;

    const email = makeUniqueEmail('resend-flow');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const regRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: 'Cụm mật khẩu an toàn test resend 2026',
          displayName: 'Resend User',
          dateOfBirth: '1998-02-14',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(regRes.status).toBe(202);
    const firstOtp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);

    // 1. Gửi lại ngay lập tức (chưa đủ 60s) -> bị chặn 429 + Retry-After.
    const tooEarlyRes = await resendPost(
      makeAuthRequest('/api/v1/auth/resend-verification', { email }, ip),
    );
    expect(tooEarlyRes.status).toBe(429);
    expect(Number(tooEarlyRes.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);

    // 2. Sau 61 giây (mô phỏng hết TTL 60s của Redis): resend thành công, OTP cũ bị vô hiệu hóa.
    testClockMs += 61_000;
    await testRateLimiter.reset(
      `resend:cooldown:${email}`,
      AUTH_RATE_LIMITS.resendVerificationCooldown,
    );
    const resend1 = await resendPost(
      makeAuthRequest('/api/v1/auth/resend-verification', { email }, ip),
    );
    expect(resend1.status).toBe(200);
    const secondOtp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);

    // Nếu vô tình sinh trùng số (xác suất 1/10^6), kiểm tra ít nhất bảng tokens có token cũ consumed_at != null.
    const db = getDb();
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    const allTokens = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.userId, identity!.userId));
    expect(allTokens).toHaveLength(2);
    const consumedCount = allTokens.filter((t) => t.consumedAt !== null).length;
    expect(consumedCount).toBe(1);

    if (firstOtp !== secondOtp) {
      const oldOtpRes = await verifyPost(
        makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: firstOtp }, ip),
      );
      expect(oldOtpRes.status).toBe(400);
    }

    // 3. Tiếp tục gửi lại qua các khung 15 phút khác nhau để kiểm tra trần 5 lần/giờ theo email.
    // Đã dùng 1 lần resend thành công (resend1). Thêm 4 lần nữa (tổng 5 lần/giờ) dùng IP khác nhau.
    for (let i = 0; i < 4; i += 1) {
      // Dịch 31 phút sau lần thứ 2 để qua hẳn 2 cửa sổ 15 phút (weightedPrev = 0) mà vẫn cùng khung 1 giờ.
      testClockMs += i === 2 ? 31 * 60 * 1000 : 65_000;
      await testRateLimiter.reset(
        `resend:cooldown:${email}`,
        AUTH_RATE_LIMITS.resendVerificationCooldown,
      );
      const resendIp = nextTestIp();
      usedRateLimitIps.add(resendIp);

      const res = await resendPost(
        makeAuthRequest('/api/v1/auth/resend-verification', { email }, resendIp),
      );
      expect(res.status).toBe(200);
    }

    // Lần resend thứ 6 trong cùng 1 giờ (dù đã qua 65s cooldown và đổi IP) phải trả 429 RATE_LIMITED!
    testClockMs += 65_000;
    await testRateLimiter.reset(
      `resend:cooldown:${email}`,
      AUTH_RATE_LIMITS.resendVerificationCooldown,
    );
    const sixthIp = nextTestIp();
    usedRateLimitIps.add(sixthIp);
    const sixthResend = await resendPost(
      makeAuthRequest('/api/v1/auth/resend-verification', { email }, sixthIp),
    );
    expect(sixthResend.status).toBe(429);
    const sixthBody = (await sixthResend.json()) as { error: { code: string } };
    expect(sixthBody.error.code).toBe('RATE_LIMITED');

    // Cuối cùng xác minh bằng mã OTP mới nhất -> tài khoản chuyển sang `active`.
    const latestOtp = extractSixDigitOtp(emailSpy.getLatestFor(email)!.text);
    const finalVerify = await verifyPost(
      makeAuthRequest('/api/v1/auth/verify-email', { email, otpCode: latestOtp }, ip),
    );
    expect(finalVerify.status).toBe(200);
  });

  it('Bảo mật: vượt ngưỡng Rate Limit trên /register (> 5 lần / 15 phút theo IP) trả về 429 + Retry-After', async () => {
    const sharedIp = nextTestIp();
    usedRateLimitIps.add(sharedIp);

    for (let i = 1; i <= 5; i += 1) {
      const email = makeUniqueEmail(`rl-${i}`);
      createdEmails.add(email);
      const res = await registerPost(
        makeAuthRequest(
          '/api/v1/auth/register',
          {
            email,
            password: 'Cụm mật khẩu an toàn kiểm tra rate limit 2026',
            displayName: `RL User ${i}`,
            dateOfBirth: '1999-09-09',
            acceptedTerms: true,
            captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
          },
          sharedIp,
        ),
      );
      expect(res.status).toBe(202);
    }

    const sixthEmail = makeUniqueEmail('rl-6-blocked');
    createdEmails.add(sixthEmail);
    const blockedRes = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email: sixthEmail,
          password: 'Cụm mật khẩu an toàn kiểm tra rate limit 2026',
          displayName: 'RL User 6',
          dateOfBirth: '1999-09-09',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        sharedIp,
      ),
    );

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(Number(blockedRes.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const body = (await blockedRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('Bảo mật: đăng ký trùng tài khoản pending_verification (< 24h không bị tráo mật khẩu; >= 24h cho phép đăng ký đè)', async () => {
    const email = makeUniqueEmail('pending-takeover');
    createdEmails.add(email);
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);
    const victimPassword = 'Mật khẩu gốc của nạn nhân 2026!';
    const attackerPassword = 'Mật khẩu kẻ tấn công muốn tráo 2026!';

    // 1. Nạn nhân đăng ký (pending_verification).
    const first = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: victimPassword,
          displayName: 'Nạn Nhân',
          dateOfBirth: '1999-01-01',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(first.status).toBe(202);

    // 2. Sau 2 phút (< 24h), kẻ tấn công đăng ký trùng email với mật khẩu khác.
    testClockMs += 2 * 60 * 1000;
    await testRateLimiter.reset(
      `resend:cooldown:${email}`,
      AUTH_RATE_LIMITS.resendVerificationCooldown,
    );
    const second = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: attackerPassword,
          displayName: 'Kẻ Tấn Công',
          dateOfBirth: '2000-02-02',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        ip,
      ),
    );
    expect(second.status).toBe(202);

    const db = getDb();
    const [identityMid] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    // Mật khẩu của nạn nhân vẫn còn nguyên, không bị ghi đè!
    expect(
      (await verifyPassword(victimPassword, identityMid!.passwordHash!, identityMid!.pepperVersion))
        .valid,
    ).toBe(true);
    expect(
      (
        await verifyPassword(
          attackerPassword,
          identityMid!.passwordHash!,
          identityMid!.pepperVersion,
        )
      ).valid,
    ).toBe(false);

    // 3. Sau 25 giờ (>= 24h quá hạn chưa xác minh), người dùng mới được phép đăng ký đè sạch sẽ.
    testClockMs += PENDING_VERIFICATION_EXPIRY_MS + 60 * 60 * 1000;
    const newOwnerPassword = 'Mật khẩu mới hợp lệ sau khi hết hạn 24h!';
    const thirdIp = nextTestIp();
    usedRateLimitIps.add(thirdIp);

    const third = await registerPost(
      makeAuthRequest(
        '/api/v1/auth/register',
        {
          email,
          password: newOwnerPassword,
          displayName: 'Người Dùng Mới',
          dateOfBirth: '1998-08-08',
          acceptedTerms: true,
          captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
        thirdIp,
      ),
    );
    expect(third.status).toBe(202);

    const [identityAfter] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.identifierNormalized, email));
    expect(
      (
        await verifyPassword(
          newOwnerPassword,
          identityAfter!.passwordHash!,
          identityAfter!.pepperVersion,
        )
      ).valid,
    ).toBe(true);
  });
});
