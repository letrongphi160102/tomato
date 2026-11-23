import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as changePasswordOtpPost } from '@/app/api/v1/auth/change-password/request-otp/route';
import { POST as changePasswordPost } from '@/app/api/v1/auth/change-password/route';
import { POST as verifyChangePasswordOtpPost } from '@/app/api/v1/auth/change-password/verify-otp/route';
import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { GET as meGet } from '@/app/api/v1/auth/me/route';
import { POST as refreshPost } from '@/app/api/v1/auth/refresh/route';
import { DELETE as deleteSessionRoute } from '@/app/api/v1/auth/sessions/[sessionPublicId]/route';
import { GET as sessionsGet } from '@/app/api/v1/auth/sessions/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { auditLogs, authIdentities, sessions, users } from '@/core/db/schema';
import { type EmailMessage, type EmailProvider } from '@/core/email';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  AuthRepository,
  AuthService,
  PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS,
  SESSION_ONLINE_THRESHOLD_MS,
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
  return `198.51.100.${(ipCounter % 220) + 20}`;
}

function makeUniqueEmail(label: string): string {
  return `m6-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tomato.test`;
}

function makeUniqueUsername(label: string): string {
  const safe = label
    .replace(/[^a-z0-9_]/gi, '_')
    .slice(0, 10)
    .toLowerCase();
  return `${safe}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class MemoryEmailCapture implements EmailProvider {
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
}

function extractSixDigitOtp(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy mã OTP 6 chữ số trong email');
  }
  return match[1];
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
  pwdTicket?: string;
}

function extractCookies(response: Response, previous: CookieJar = {}): CookieJar {
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

function serializeJar(jar: CookieJar): string {
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

function makePost(
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
    const cookieHeader = serializeJar(options.jar);
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

function makeGet(pathname: string, jar: CookieJar, ip: string): Request {
  return new Request(`${getTestOrigin()}${pathname}`, {
    method: 'GET',
    headers: {
      cookie: serializeJar(jar),
      'x-forwarded-for': ip,
    },
  });
}

function makeDelete(pathname: string, jar: CookieJar, ip: string): Request {
  const origin = getTestOrigin();
  return new Request(`${origin}${pathname}`, {
    method: 'DELETE',
    headers: {
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      cookie: serializeJar(jar),
      ...(jar.csrf ? { [CSRF_HEADER_NAME]: jar.csrf } : {}),
      'x-forwarded-for': ip,
    },
  });
}

describe('Integration M6: Đổi mật khẩu 2 bước (kèm Silent Refresh giữa chừng) & Quản lý Thiết bị Online/Offline/Lịch sử (PostgreSQL + Redis thật)', () => {
  const createdUserIds: string[] = [];
  let emailCapture: MemoryEmailCapture;
  let currentClock: Date;

  beforeEach(() => {
    currentClock = new Date();
    emailCapture = new MemoryEmailCapture();

    const runSuffix = `${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    const rateLimiter = new RateLimiter(getRedisClient(), {
      keyPrefix: `tomato:rl:m6test:${runSuffix}`,
      now: () => currentClock.getTime(),
    });
    const loginProtection = new LoginBruteForceGuard(getRedisClient(), {
      keyPrefix: `tomato:bf:m6test:${runSuffix}`,
      now: () => currentClock.getTime(),
    });
    const repository = new AuthRepository();
    const auditLogService = new AuditLogService();
    const sessionService = new SessionService({
      repository,
      rateLimiter,
      auditLogService,
      now: () => currentClock,
    });
    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter,
      loginProtection,
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

  async function seedActiveUser(email: string, password: string) {
    const db = getDb();
    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const identityId = generateUuidV7();
    const hashed = await hashPassword(password);
    const now = currentClock;

    await db.insert(users).values({
      id: userId,
      publicId,
      username: makeUniqueUsername('m6usr'),
      fullName: 'Nguyen Thi M6',
      gender: 'female',
      dateOfBirth: '1997-04-12',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(authIdentities).values({
      id: identityId,
      userId,
      provider: 'email_password',
      identifierNormalized: email.trim().toLowerCase(),
      passwordHash: hashed.hash,
      pepperVersion: hashed.pepperVersion,
      verifiedAt: now,
      failedLoginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    createdUserIds.push(userId);
    return { userId, publicId };
  }

  async function loginDevice(email: string, password: string, ip: string, userAgent: string) {
    const res = await loginPost(
      makePost('/api/v1/auth/login', {
        body: { email, password },
        ip,
        userAgent,
        includeCsrfHeader: false,
      }),
    );
    expect(res.status).toBe(200);
    return extractCookies(res);
  }

  it('Đổi mật khẩu 2 bước: Silent Refresh xoay vòng RT giữa Bước 1 và Bước 2 vẫn thành công, chặn replay ticket và chặn dùng chéo sang Thiết bị B', async () => {
    const email = makeUniqueEmail('twostep-refresh');
    const oldPassword = 'old strong passphrase m6 2026!';
    const newPassword = 'new strong passphrase m6 2027!';
    await seedActiveUser(email, oldPassword);

    const ipA = nextTestIp();
    const ipB = nextTestIp();
    let jarA = await loginDevice(
      email,
      oldPassword,
      ipA,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    );
    const jarB = await loginDevice(
      email,
      oldPassword,
      ipB,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1',
    );

    // Bước 1a: gửi OTP
    const reqOtpRes = await changePasswordOtpPost(
      makePost('/api/v1/auth/change-password/request-otp', { jar: jarA, ip: ipA }),
    );
    expect(reqOtpRes.status).toBe(200);
    const otpCode = extractSixDigitOtp(emailCapture.getLatestFor(email)!.text);

    // Bước 1b: xác minh OTP -> nhận HttpOnly ticket cookie gắn với family_id của Thiết bị A
    const verifyRes = await verifyChangePasswordOtpPost(
      makePost('/api/v1/auth/change-password/verify-otp', {
        body: { otpCode },
        jar: jarA,
        ip: ipA,
      }),
    );
    expect(verifyRes.status).toBe(200);
    jarA = extractCookies(verifyRes, jarA);
    const ticketFromDeviceA = jarA.pwdTicket;
    expect(ticketFromDeviceA).toBeTruthy();

    // Thiết bị B cố đánh cắp ticket của Thiết bị A để đổi mật khẩu -> bị chặn 403 TOKEN_INVALID!
    const crossDeviceRes = await changePasswordPost(
      makePost('/api/v1/auth/change-password', {
        body: { currentPassword: oldPassword, newPassword },
        jar: { ...jarB, pwdTicket: ticketFromDeviceA },
        ip: ipB,
      }),
    );
    expect(crossDeviceRes.status).toBe(403);
    expect(((await crossDeviceRes.json()) as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );

    // Giả lập Silent Refresh xảy ra giữa Bước 1 và Bước 2 trên Thiết bị A (xoay vòng session.id trong cùng family_id).
    currentClock = new Date(currentClock.getTime() + 2 * 60 * 1000);
    const refreshRes = await refreshPost(makePost('/api/v1/auth/refresh', { jar: jarA, ip: ipA }));
    expect(refreshRes.status).toBe(200);
    // Đảm bảo refresh vẫn gắn cookie RT bền vững (Max-Age > 1 ngày).
    const rtSetCookie = refreshRes.headers.getSetCookie().find((c) => c.startsWith('tomato_rt='));
    expect(rtSetCookie).toMatch(/Max-Age=\d{6,}/i);
    jarA = extractCookies(refreshRes, jarA);

    // Bước 2 trên Thiết bị A với AT/RT vừa xoay vòng + ticket Bước 1 -> VẪN THÀNH CÔNG 200!
    const changeRes = await changePasswordPost(
      makePost('/api/v1/auth/change-password', {
        body: { currentPassword: oldPassword, newPassword },
        jar: jarA,
        ip: ipA,
      }),
    );
    expect(changeRes.status).toBe(200);
    const jarAAfterChange = extractCookies(changeRes, jarA);
    expect(jarAAfterChange.pwdTicket).toBeUndefined();

    // Tái sử dụng ticket cũ sau khi đã đổi mật khẩu -> bị từ chối 403 TOKEN_INVALID.
    const replayRes = await changePasswordPost(
      makePost('/api/v1/auth/change-password', {
        body: { currentPassword: newPassword, newPassword: 'third safe passphrase 2028!' },
        jar: { ...jarAAfterChange, pwdTicket: ticketFromDeviceA },
        ip: ipA,
      }),
    );
    expect(replayRes.status).toBe(403);
  });

  it('Bước 2 đổi mật khẩu: nhập sai mật khẩu hiện tại 5 lần liên tiếp tự động hủy ticket (403)', async () => {
    const email = makeUniqueEmail('ticket-exhaust');
    const password = 'valid strong passphrase 2026!';
    await seedActiveUser(email, password);

    const ip = nextTestIp();
    let jar = await loginDevice(
      email,
      password,
      ip,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    );

    await changePasswordOtpPost(makePost('/api/v1/auth/change-password/request-otp', { jar, ip }));
    const otp = extractSixDigitOtp(emailCapture.getLatestFor(email)!.text);
    const verifyRes = await verifyChangePasswordOtpPost(
      makePost('/api/v1/auth/change-password/verify-otp', { body: { otpCode: otp }, jar, ip }),
    );
    expect(verifyRes.status).toBe(200);
    jar = extractCookies(verifyRes, jar);

    // 4 lần đầu sai mật khẩu hiện tại -> 400 INVALID_CREDENTIALS.
    for (let i = 1; i < PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS; i += 1) {
      const wrongRes = await changePasswordPost(
        makePost('/api/v1/auth/change-password', {
          body: {
            currentPassword: `wrong passphrase attempt ${i}`,
            newPassword: 'brand new safe passphrase 2027!',
          },
          jar,
          ip: nextTestIp(),
        }),
      );
      expect(wrongRes.status).toBe(400);
    }

    // Lần thứ 5 sai -> 403 TOKEN_INVALID và hủy ticket + xóa cookie.
    const fifthRes = await changePasswordPost(
      makePost('/api/v1/auth/change-password', {
        body: {
          currentPassword: 'wrong passphrase attempt 5',
          newPassword: 'brand new safe passphrase 2027!',
        },
        jar,
        ip: nextTestIp(),
      }),
    );
    expect(fifthRes.status).toBe(403);
    expect(
      fifthRes.headers
        .getSetCookie()
        .some((c) => c.startsWith('tomato_pwd_ticket=') && c.includes('Max-Age=0')),
    ).toBe(true);
  });

  it('Quản lý thiết bị & Lịch sử: gom nhóm chuẩn theo family_id (không trùng sau nhiều lần /refresh), phân biệt Online/Offline, lịch sử Đã đăng xuất/Đã hết hạn và chặn 404 khi xóa lịch sử', async () => {
    const email = makeUniqueEmail('devices-history');
    const password = 'device history passphrase 2026!';
    const seeded = await seedActiveUser(email, password);

    const ip1 = nextTestIp();
    const ip2 = nextTestIp();
    const ip3 = nextTestIp();

    // Đăng nhập 3 thiết bị
    let device1 = await loginDevice(
      email,
      password,
      ip1,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
    );
    const device2 = await loginDevice(
      email,
      password,
      ip2,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.1 Safari/605.1.15',
    );
    const device3 = await loginDevice(
      email,
      password,
      ip3,
      'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
    );
    expect(device2.at).toBeTruthy();
    expect(device3.at).toBeTruthy();

    // Xoay vòng Refresh Token 3 lần liên tiếp trên Thiết bị 1 -> tạo 3 bản ghi token_rotated trong DB.
    for (let i = 0; i < 3; i += 1) {
      currentClock = new Date(currentClock.getTime() + 60 * 1000);
      const r = await refreshPost(makePost('/api/v1/auth/refresh', { jar: device1, ip: ip1 }));
      expect(r.status).toBe(200);
      device1 = extractCookies(r, device1);
    }

    // Tua đồng hồ thêm 20 phút (> 15p Online threshold và > 15p hạn AT):
    // Thiết bị 1 thực hiện Silent Refresh để nhận AT mới và cập nhật hoạt động gần nhất,
    // sau đó kiểm tra `/me` thành công 200 trong khi Thiết bị 2 & 3 trở thành Ngoại tuyến (offline).
    currentClock = new Date(currentClock.getTime() + SESSION_ONLINE_THRESHOLD_MS + 5 * 60 * 1000);
    const expiredAtMe = await meGet(makeGet('/api/v1/auth/me', device1, ip1));
    expect(expiredAtMe.status).toBe(401);

    const silentRefresh = await refreshPost(
      makePost('/api/v1/auth/refresh', { jar: device1, ip: ip1 }),
    );
    expect(silentRefresh.status).toBe(200);
    device1 = extractCookies(silentRefresh, device1);

    const me1 = await meGet(makeGet('/api/v1/auth/me', device1, ip1));
    expect(me1.status).toBe(200);

    // Gọi GET /sessions -> phải gom đúng còn đúng 3 thiết bị (KHÔNG lộ các dòng token_rotated),
    // Thiết bị 1 Online, Thiết bị 2 & 3 Offline, history = [].
    const list1Res = await sessionsGet(makeGet('/api/v1/auth/sessions', device1, ip1));
    expect(list1Res.status).toBe(200);
    const list1 = (await list1Res.json()) as {
      sessions: Array<{
        public_id: string;
        deviceInfo: string;
        isCurrent: boolean;
        activityStatus: 'online' | 'offline';
      }>;
      history: Array<{
        public_id: string;
        deviceInfo: string;
        historyStatus: 'logged_out' | 'expired';
      }>;
    };

    expect(list1.sessions).toHaveLength(3);
    expect(list1.history).toHaveLength(0);
    expect(list1.sessions[0]?.isCurrent).toBe(true);
    expect(list1.sessions[0]?.activityStatus).toBe('online');

    const safariSession = list1.sessions.find((s) => s.deviceInfo.includes('Safari 18'));
    const firefoxSession = list1.sessions.find((s) => s.deviceInfo.includes('Firefox 132'));
    expect(safariSession?.activityStatus).toBe('offline');
    expect(firefoxSession?.activityStatus).toBe('offline');

    // Đăng xuất từ xa Thiết bị 2 (Safari) và đặt hết hạn Thiết bị 3 (Firefox) trong DB.
    const revokeSafariRes = await deleteSessionRoute(
      makeDelete(`/api/v1/auth/sessions/${safariSession!.public_id}`, device1, ip1),
      { params: Promise.resolve({ sessionPublicId: safariSession!.public_id }) },
    );
    expect(revokeSafariRes.status).toBe(200);

    const db = getDb();
    await db
      .update(sessions)
      .set({ expiresAt: new Date(currentClock.getTime() - 60_000) })
      .where(eq(sessions.publicId, firefoxSession!.public_id));

    // Gọi lại GET /sessions: chỉ còn Thiết bị 1 trong `sessions`, Thiết bị 2 & 3 nằm sạch trong `history`!
    const list2Res = await sessionsGet(makeGet('/api/v1/auth/sessions', device1, ip1));
    expect(list2Res.status).toBe(200);
    const list2 = (await list2Res.json()) as {
      sessions: Array<{ public_id: string; isCurrent: boolean }>;
      history: Array<{
        public_id: string;
        deviceInfo: string;
        historyStatus: 'logged_out' | 'expired';
      }>;
    };

    expect(list2.sessions).toHaveLength(1);
    expect(list2.sessions[0]?.isCurrent).toBe(true);
    expect(list2.history).toHaveLength(2);
    expect(list2.history.find((h) => h.public_id === safariSession!.public_id)?.historyStatus).toBe(
      'logged_out',
    );
    expect(
      list2.history.find((h) => h.public_id === firefoxSession!.public_id)?.historyStatus,
    ).toBe('expired');

    // Không bao giờ lộ internal UUIDv7 hay familyId trong cả sessions lẫn history.
    const serialized = JSON.stringify(list2);
    expect(serialized).not.toContain(seeded.userId);
    expect(serialized).not.toContain('familyId');
    expect(serialized).not.toContain('refreshTokenHash');

    // Cố gọi DELETE trên mục đã ở trong lịch sử (đã đăng xuất hoặc đã hết hạn) -> trả 404 NOT_FOUND.
    const deleteLoggedOutRes = await deleteSessionRoute(
      makeDelete(`/api/v1/auth/sessions/${safariSession!.public_id}`, device1, ip1),
      { params: Promise.resolve({ sessionPublicId: safariSession!.public_id }) },
    );
    expect(deleteLoggedOutRes.status).toBe(404);

    const deleteExpiredRes = await deleteSessionRoute(
      makeDelete(`/api/v1/auth/sessions/${firefoxSession!.public_id}`, device1, ip1),
      { params: Promise.resolve({ sessionPublicId: firefoxSession!.public_id }) },
    );
    expect(deleteExpiredRes.status).toBe(404);
  });
});
