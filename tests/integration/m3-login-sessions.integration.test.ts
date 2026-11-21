import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as logoutPost } from '@/app/api/v1/auth/logout/route';
import { GET as meGet } from '@/app/api/v1/auth/me/route';
import { POST as refreshPost } from '@/app/api/v1/auth/refresh/route';
import { DELETE as deleteSessionRoute } from '@/app/api/v1/auth/sessions/[sessionPublicId]/route';
import { POST as revokeAllRoute } from '@/app/api/v1/auth/sessions/revoke-all/route';
import { GET as sessionsGet } from '@/app/api/v1/auth/sessions/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword, verifyPassword, type PepperSecretProvider } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { auditLogs, authIdentities, sessions, users, type UserStatus } from '@/core/db/schema';
import { AUTH_RATE_LIMITS, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  AUTH_MESSAGES,
  AuthRepository,
  AuthService,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
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
  return `203.0.113.${(ipCounter % 240) + 10}`;
}

function makeUniqueEmail(label: string): string {
  return `m3-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@tomato.test`;
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
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
  return parts.join('; ');
}

function makeJsonPostRequest(
  pathname: string,
  options: {
    readonly body?: unknown;
    readonly jar?: CookieJar;
    readonly ip: string;
    readonly userAgent?: string;
    readonly includeCsrfHeader?: boolean;
    readonly origin?: string | null;
    readonly secFetchSite?: string;
  },
): Request {
  const origin = options.origin === undefined ? getTestOrigin() : options.origin;
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip,
    'user-agent':
      options.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };

  if (origin !== null) {
    headers['Origin'] = origin;
  }
  if (options.secFetchSite !== undefined) {
    headers['Sec-Fetch-Site'] = options.secFetchSite;
  } else {
    headers['Sec-Fetch-Site'] = 'same-origin';
  }
  if (options.jar) {
    const cookieHeader = serializeCookieJar(options.jar);
    if (cookieHeader) {
      headers['cookie'] = cookieHeader;
    }
    if (options.includeCsrfHeader && options.jar.csrf) {
      headers[CSRF_HEADER_NAME] = options.jar.csrf;
    }
  }

  const hasBody = options.body !== undefined;
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }

  return new Request(`${getTestOrigin()}${pathname}`, {
    method: 'POST',
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
}

function makeGetRequest(pathname: string, jar: CookieJar, ip: string): Request {
  return new Request(`${getTestOrigin()}${pathname}`, {
    method: 'GET',
    headers: {
      cookie: serializeCookieJar(jar),
      'x-forwarded-for': ip,
      'user-agent': 'Vitest-M3-Client/1.0',
    },
  });
}

function makeDeleteRequest(
  pathname: string,
  jar: CookieJar,
  ip: string,
  options?: { readonly includeCsrfHeader?: boolean; readonly origin?: string },
): Request {
  const headers: Record<string, string> = {
    Origin: options?.origin ?? getTestOrigin(),
    'Sec-Fetch-Site': 'same-origin',
    cookie: serializeCookieJar(jar),
    'x-forwarded-for': ip,
    'user-agent': 'Vitest-M3-Client/1.0',
  };
  if ((options?.includeCsrfHeader ?? true) && jar.csrf) {
    headers[CSRF_HEADER_NAME] = jar.csrf;
  }
  return new Request(`${getTestOrigin()}${pathname}`, {
    method: 'DELETE',
    headers,
  });
}

describe('Integration & Security M3: Đăng nhập, Xoay vòng Phiên, Reuse Detection, IDOR & CSRF (PostgreSQL + Redis thật)', () => {
  const testRunPrefix = `tomato:m3:itest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const createdUserIds = new Set<string>();
  const usedRateLimitIps = new Set<string>();
  let testClockMs = Date.now();
  let testRateLimiter: RateLimiter;

  function installIsolatedServices(options?: { readonly pepperProvider?: PepperSecretProvider }) {
    const db = getDb();
    const redis = getRedisClient();
    const repository = new AuthRepository(() => db);
    const auditLogService = new AuditLogService(() => db);
    testRateLimiter = new RateLimiter(redis, {
      keyPrefix: testRunPrefix,
      now: () => testClockMs,
    });

    const sessionService = new SessionService({
      repository,
      rateLimiter: testRateLimiter,
      auditLogService,
      now: () => new Date(testClockMs),
    });

    const authService = new AuthService({
      repository,
      sessionService,
      rateLimiter: testRateLimiter,
      auditLogService,
      pepperProvider: options?.pepperProvider,
      now: () => new Date(testClockMs),
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
  }

  async function seedUser(params: {
    readonly email: string;
    readonly password: string;
    readonly displayName?: string;
    readonly status?: UserStatus;
    readonly pepperProvider?: PepperSecretProvider;
  }) {
    const db = getDb();
    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const identityId = generateUuidV7();
    const hashed = await hashPassword(params.password, params.pepperProvider);
    const now = new Date(testClockMs);

    await db.insert(users).values({
      id: userId,
      publicId,
      displayName: params.displayName ?? 'TOMATO Tester',
      dateOfBirth: '1998-05-15',
      status: params.status ?? 'active',
      createdAt: now,
      updatedAt: now,
      deletedAt: params.status === 'deleted' ? now : null,
    });

    await db.insert(authIdentities).values({
      id: identityId,
      userId,
      provider: 'email_password',
      identifierNormalized: params.email,
      passwordHash: hashed.hash,
      pepperVersion: hashed.pepperVersion,
      verifiedAt: params.status === 'pending_verification' ? null : now,
      failedLoginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    createdUserIds.add(userId);
    return { userId, publicId, identityId, email: params.email };
  }

  beforeEach(() => {
    testClockMs = Date.now();
    installIsolatedServices();
  });

  afterAll(async () => {
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();

    const db = getDb();
    const redis = getRedisClient();

    for (const userId of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }

    const limiter = new RateLimiter(redis, {
      keyPrefix: testRunPrefix,
      now: () => testClockMs,
    });
    for (const ip of usedRateLimitIps) {
      await limiter.reset(`login:ip:${ip}`, AUTH_RATE_LIMITS.loginByIp);
      await limiter.reset(`refresh:ip:${ip}`, AUTH_RATE_LIMITS.refreshByIp);
    }

    await Promise.all([closeDatabasePool(), closeRedisClient()]);
  });

  it('Luồng chuẩn đầy đủ: Login -> /me -> /refresh nhận cặp token mới -> /sessions -> thu hồi 1 thiết bị -> đăng xuất tất cả thiết bị khác -> /logout', async () => {
    const email = makeUniqueEmail('happy-flow');
    const password = 'Cụm mật khẩu đăng nhập an toàn 2026!';
    const seeded = await seedUser({ email, password, displayName: 'Nguyễn An Nhiên' });

    const ip1 = nextTestIp();
    const ip2 = nextTestIp();
    const ip3 = nextTestIp();
    usedRateLimitIps.add(ip1);
    usedRateLimitIps.add(ip2);
    usedRateLimitIps.add(ip3);

    // 1. Login Thiết bị 1 (Chrome / Windows)
    const loginRes1 = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: `  ${email.toUpperCase()}  `, password },
        ip: ip1,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      }),
    );

    expect(loginRes1.status).toBe(200);
    expect(loginRes1.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const loginJson1 = (await loginRes1.json()) as {
      user: Record<string, unknown>;
      message: string;
    };
    expect(loginJson1.user).toEqual({
      public_id: seeded.publicId,
      displayName: 'Nguyễn An Nhiên',
      status: 'active',
    });
    // Tuyệt đối không lộ id nội bộ (UUIDv7) hay token trong JSON body.
    expect(loginJson1.user).not.toHaveProperty('id');
    expect(loginJson1).not.toHaveProperty('accessToken');
    expect(loginJson1).not.toHaveProperty('refreshToken');

    const rawSetCookies = loginRes1.headers.getSetCookie();
    expect(rawSetCookies.some((c) => c.startsWith('tomato_at=') && c.includes('HttpOnly'))).toBe(
      true,
    );
    expect(rawSetCookies.some((c) => c.startsWith('tomato_rt=') && c.includes('HttpOnly'))).toBe(
      true,
    );
    expect(rawSetCookies.some((c) => c.startsWith('tomato_csrf=') && !c.includes('HttpOnly'))).toBe(
      true,
    );

    let device1Jar = extractCookiesFromResponse(loginRes1);
    expect(device1Jar.at).toBeTruthy();
    expect(device1Jar.rt).toBeTruthy();
    expect(device1Jar.csrf).toBeTruthy();

    // 2. Gọi GET /api/v1/auth/me
    const meRes = await meGet(makeGetRequest('/api/v1/auth/me', device1Jar, ip1));
    expect(meRes.status).toBe(200);
    expect(meRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const meJson = (await meRes.json()) as Record<string, unknown>;
    expect(meJson).toEqual({
      public_id: seeded.publicId,
      displayName: 'Nguyễn An Nhiên',
      status: 'active',
    });
    expect(meJson).not.toHaveProperty('id');

    // 3. Gọi POST /api/v1/auth/refresh nhận cặp AT2 + RT2 mới
    testClockMs += 5 * 60 * 1000;
    const oldAt1 = device1Jar.at!;
    const oldRt1 = device1Jar.rt!;

    const refreshRes = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: device1Jar,
        includeCsrfHeader: true,
        ip: ip1,
      }),
    );
    expect(refreshRes.status).toBe(200);
    device1Jar = extractCookiesFromResponse(refreshRes, device1Jar);
    expect(device1Jar.at).toBeTruthy();
    expect(device1Jar.rt).toBeTruthy();
    expect(device1Jar.at).not.toBe(oldAt1);
    expect(device1Jar.rt).not.toBe(oldRt1);

    // 4. Đăng nhập thêm Thiết bị 2 (Safari / macOS) và Thiết bị 3 (Firefox / Linux)
    const loginRes2 = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email, password },
        ip: ip2,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      }),
    );
    expect(loginRes2.status).toBe(200);
    const device2Jar = extractCookiesFromResponse(loginRes2);

    const loginRes3 = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email, password },
        ip: ip3,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      }),
    );
    expect(loginRes3.status).toBe(200);
    const device3Jar = extractCookiesFromResponse(loginRes3);

    // 5. Xem danh sách thiết bị từ Thiết bị 1
    const sessionsRes = await sessionsGet(makeGetRequest('/api/v1/auth/sessions', device1Jar, ip1));
    expect(sessionsRes.status).toBe(200);
    const sessionsJson = (await sessionsRes.json()) as {
      sessions: Array<{
        public_id: string;
        deviceInfo: string;
        ipAddress: string;
        isCurrent: boolean;
      }>;
    };

    expect(sessionsJson.sessions).toHaveLength(3);
    expect(sessionsJson.sessions.filter((s) => s.isCurrent)).toHaveLength(1);
    // Tuyệt đối không lộ id nội bộ, familyId hay refreshTokenHash.
    for (const item of sessionsJson.sessions) {
      expect(item).not.toHaveProperty('id');
      expect(item).not.toHaveProperty('userId');
      expect(item).not.toHaveProperty('familyId');
      expect(item).not.toHaveProperty('refreshTokenHash');
    }

    const device2Session = sessionsJson.sessions.find((s) => s.deviceInfo.includes('Safari 18'));
    expect(device2Session).toBeDefined();
    expect(device2Session?.isCurrent).toBe(false);

    // 6. Thu hồi riêng Thiết bị 2 từ Thiết bị 1
    const revokeOneRes = await deleteSessionRoute(
      makeDeleteRequest(`/api/v1/auth/sessions/${device2Session!.public_id}`, device1Jar, ip1),
      { params: Promise.resolve({ sessionPublicId: device2Session!.public_id }) },
    );
    expect(revokeOneRes.status).toBe(200);

    // Thiết bị 2 bị vô hiệu hóa ngay lập tức trên cả `/me` lẫn `/refresh`.
    const device2MeAfter = await meGet(makeGetRequest('/api/v1/auth/me', device2Jar, ip2));
    expect(device2MeAfter.status).toBe(401);
    const device2RefreshAfter = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: device2Jar,
        includeCsrfHeader: true,
        ip: ip2,
      }),
    );
    expect(device2RefreshAfter.status).toBe(401);

    // 7. Đăng xuất tất cả thiết bị khác từ Thiết bị 1
    const revokeAllRes = await revokeAllRoute(
      makeJsonPostRequest('/api/v1/auth/sessions/revoke-all', {
        body: { includeCurrent: false },
        jar: device1Jar,
        includeCsrfHeader: true,
        ip: ip1,
      }),
    );
    expect(revokeAllRes.status).toBe(200);
    const revokeAllJson = (await revokeAllRes.json()) as {
      revokedCount: number;
      includeCurrent: boolean;
    };
    expect(revokeAllJson.revokedCount).toBe(1); // Thiết bị 3
    expect(revokeAllJson.includeCurrent).toBe(false);

    // Thiết bị 3 bị thu hồi; Thiết bị 1 vẫn hoạt động bình thường.
    const device3MeAfter = await meGet(makeGetRequest('/api/v1/auth/me', device3Jar, ip3));
    expect(device3MeAfter.status).toBe(401);
    const device1MeStillOk = await meGet(makeGetRequest('/api/v1/auth/me', device1Jar, ip1));
    expect(device1MeStillOk.status).toBe(200);

    // 8. Đăng xuất Thiết bị 1 qua POST /logout -> xóa phiên & xóa sạch cookie
    const logoutRes = await logoutPost(
      makeJsonPostRequest('/api/v1/auth/logout', {
        jar: device1Jar,
        includeCsrfHeader: true,
        ip: ip1,
      }),
    );
    expect(logoutRes.status).toBe(200);
    const logoutSetCookies = logoutRes.headers.getSetCookie();
    expect(
      logoutSetCookies.some((c) => c.startsWith('tomato_at=') && c.includes('Max-Age=0')),
    ).toBe(true);
    expect(
      logoutSetCookies.some((c) => c.startsWith('tomato_rt=') && c.includes('Max-Age=0')),
    ).toBe(true);
    expect(
      logoutSetCookies.some((c) => c.startsWith('tomato_csrf=') && c.includes('Max-Age=0')),
    ).toBe(true);

    // AT cũ của Thiết bị 1 bị từ chối 401 sau khi logout.
    const device1MeAfterLogout = await meGet(makeGetRequest('/api/v1/auth/me', device1Jar, ip1));
    expect(device1MeAfterLogout.status).toBe(401);
  });

  it('Bảo mật (Reuse Detection trên PostgreSQL thật): Dùng lại RT1 sau khi đã xoay sang RT2 -> thu hồi toàn bộ family_id & ghi TOKEN_REUSE_DETECTED', async () => {
    const email = makeUniqueEmail('reuse-detection');
    const password = 'Cụm mật khẩu kiểm thử Reuse Detection 2026!';
    const seeded = await seedUser({ email, password });

    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    // 1. Login -> nhận RT1
    const loginRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', { body: { email, password }, ip }),
    );
    expect(loginRes.status).toBe(200);
    const jar1 = extractCookiesFromResponse(loginRes);
    const rt1 = jar1.rt!;

    // 2. Xoay vòng hợp lệ RT1 -> RT2
    testClockMs += 60_000;
    const rotateRes = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: jar1,
        includeCsrfHeader: true,
        ip,
      }),
    );
    expect(rotateRes.status).toBe(200);
    const jar2 = extractCookiesFromResponse(rotateRes, jar1);
    const rt2 = jar2.rt!;
    expect(rt2).not.toBe(rt1);

    // 3. Kẻ tấn công tái sử dụng RT1 đã từng dùng trước đó!
    testClockMs += 10_000;
    const attackerIp = nextTestIp();
    usedRateLimitIps.add(attackerIp);

    const reuseRes = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: { rt: rt1, csrf: jar1.csrf },
        includeCsrfHeader: true,
        ip: attackerIp,
      }),
    );

    expect(reuseRes.status).toBe(401);
    const reuseCookies = reuseRes.headers.getSetCookie();
    expect(reuseCookies.some((c) => c.startsWith('tomato_rt=') && c.includes('Max-Age=0'))).toBe(
      true,
    );

    // 4. Xác minh PostgreSQL: TOÀN BỘ phiên cùng family_id (bao gồm cả RT2) đã bị thu hồi ngay lập tức!
    const db = getDb();
    const familyRows = await db.select().from(sessions).where(eq(sessions.userId, seeded.userId));
    expect(familyRows).toHaveLength(2);
    expect(familyRows.every((row) => row.familyId === familyRows[0]!.familyId)).toBe(true);
    expect(familyRows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(familyRows.some((row) => row.revokeReason === 'token_reuse')).toBe(true);

    // 5. Xác minh Audit Log có bản ghi TOKEN_REUSE_DETECTED và KHÔNG lưu token gốc.
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.userId, seeded.userId));
    const reuseLog = logs.find((l) => l.action === 'TOKEN_REUSE_DETECTED');
    expect(reuseLog).toBeDefined();
    const serializedLog = JSON.stringify(reuseLog);
    expect(serializedLog).not.toContain(rt1);
    expect(serializedLog).not.toContain(rt2);

    // 6. Cả AT2 và RT2 của nạn nhân đều bị chặn 401 ngay lập tức.
    const victimMe = await meGet(makeGetRequest('/api/v1/auth/me', jar2, ip));
    expect(victimMe.status).toBe(401);
    const victimRefresh = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: jar2,
        includeCsrfHeader: true,
        ip,
      }),
    );
    expect(victimRefresh.status).toBe(401);
  });

  it('Bảo mật (IDOR trên PostgreSQL thật): User A xóa phiên User B nhận 404 và phiên User B vẫn hoạt động bình thường', async () => {
    const password = 'Cụm mật khẩu kiểm thử IDOR 2026!';
    const userA = await seedUser({
      email: makeUniqueEmail('idor-a'),
      password,
      displayName: 'User A',
    });
    const userB = await seedUser({
      email: makeUniqueEmail('idor-b'),
      password,
      displayName: 'User B',
    });

    const ipA = nextTestIp();
    const ipB = nextTestIp();
    usedRateLimitIps.add(ipA);
    usedRateLimitIps.add(ipB);

    const loginA = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: userA.email, password },
        ip: ipA,
      }),
    );
    const loginB = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: userB.email, password },
        ip: ipB,
      }),
    );
    expect(loginA.status).toBe(200);
    expect(loginB.status).toBe(200);

    const jarA = extractCookiesFromResponse(loginA);
    const jarB = extractCookiesFromResponse(loginB);

    const sessionsBRes = await sessionsGet(makeGetRequest('/api/v1/auth/sessions', jarB, ipB));
    const sessionsBJson = (await sessionsBRes.json()) as {
      sessions: Array<{ public_id: string }>;
    };
    const sessionBPublicId = sessionsBJson.sessions[0]!.public_id;

    // User A cố gắng thu hồi phiên của User B -> phải nhận 404 Not Found.
    const idorAttempt = await deleteSessionRoute(
      makeDeleteRequest(`/api/v1/auth/sessions/${sessionBPublicId}`, jarA, ipA),
      { params: Promise.resolve({ sessionPublicId: sessionBPublicId }) },
    );
    expect(idorAttempt.status).toBe(404);
    const idorJson = (await idorAttempt.json()) as { error: { code: string } };
    expect(idorJson.error.code).toBe('NOT_FOUND');

    // Phiên User B vẫn sống và gọi `/me` thành công 200.
    const userBStillAlive = await meGet(makeGetRequest('/api/v1/auth/me', jarB, ipB));
    expect(userBStillAlive.status).toBe(200);
  });

  it('Bảo mật (CSRF trên /logout): Origin lạ hoặc thiếu X-CSRF-Token trả 403 và không đăng xuất phiên thật', async () => {
    const email = makeUniqueEmail('csrf-logout');
    const password = 'Cụm mật khẩu kiểm thử CSRF Logout 2026!';
    await seedUser({ email, password });

    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const loginRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', { body: { email, password }, ip }),
    );
    const jar = extractCookiesFromResponse(loginRes);

    // 1. Origin lạ
    const evilOriginLogout = await logoutPost(
      makeJsonPostRequest('/api/v1/auth/logout', {
        jar,
        includeCsrfHeader: true,
        origin: 'https://evil-site.invalid',
        ip,
      }),
    );
    expect(evilOriginLogout.status).toBe(403);

    // 2. Thiếu header X-CSRF-Token
    const missingCsrfLogout = await logoutPost(
      makeJsonPostRequest('/api/v1/auth/logout', {
        jar,
        includeCsrfHeader: false,
        ip,
      }),
    );
    expect(missingCsrfLogout.status).toBe(403);

    // Phiên người dùng vẫn hoàn toàn nguyên vẹn.
    const meStillOk = await meGet(makeGetRequest('/api/v1/auth/me', jar, ip));
    expect(meStillOk.status).toBe(200);
  });

  it('Tự động Rehash khi Pepper version cũ hơn CURRENT_PEPPER_VERSION và kiểm tra đủ trạng thái tài khoản', async () => {
    const v1Provider: PepperSecretProvider = {
      getCurrentVersion: () => 1,
      getPepper: (v) =>
        v === 1 ? 'pepper-secret-version-1-synthetic-at-least-32-chars' : undefined,
    };
    const v2Provider: PepperSecretProvider = {
      getCurrentVersion: () => 2,
      getPepper: (v) =>
        v === 1
          ? 'pepper-secret-version-1-synthetic-at-least-32-chars'
          : v === 2
            ? 'pepper-secret-version-2-synthetic-at-least-32-chars'
            : undefined,
    };

    const password = 'Cụm mật khẩu kiểm thử xoay vòng Pepper 2026!';
    const activeSeeded = await seedUser({
      email: makeUniqueEmail('rehash'),
      password,
      status: 'active',
      pepperProvider: v1Provider,
    });

    // Nâng Pepper hiện hành lên v2 rồi đăng nhập.
    installIsolatedServices({ pepperProvider: v2Provider });
    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const loginRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: activeSeeded.email, password },
        ip,
      }),
    );
    expect(loginRes.status).toBe(200);

    // Kiểm tra DB: đã tự động nâng cấp lên pepper_version = 2 và hash mới khớp v2.
    const db = getDb();
    const [updatedIdentity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, activeSeeded.identityId));
    expect(updatedIdentity?.pepperVersion).toBe(2);
    const verifiedWithV2 = await verifyPassword(
      password,
      updatedIdentity!.passwordHash!,
      2,
      v2Provider,
    );
    expect(verifiedWithV2).toEqual({ valid: true, needsRehash: false });

    // Kiểm tra 4 trạng thái bị chặn khi đăng nhập đúng mật khẩu.
    const pendingUser = await seedUser({
      email: makeUniqueEmail('pending'),
      password,
      status: 'pending_verification',
      pepperProvider: v2Provider,
    });
    const lockedUser = await seedUser({
      email: makeUniqueEmail('locked'),
      password,
      status: 'locked',
      pepperProvider: v2Provider,
    });
    const suspendedUser = await seedUser({
      email: makeUniqueEmail('suspended'),
      password,
      status: 'suspended',
      pepperProvider: v2Provider,
    });
    const deletedUser = await seedUser({
      email: makeUniqueEmail('deleted'),
      password,
      status: 'deleted',
      pepperProvider: v2Provider,
    });

    const pendingRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: pendingUser.email, password },
        ip,
      }),
    );
    expect(pendingRes.status).toBe(403);
    expect(((await pendingRes.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_NOT_VERIFIED',
    );

    const lockedRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: lockedUser.email, password },
        ip,
      }),
    );
    expect(lockedRes.status).toBe(403);
    expect(((await lockedRes.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_LOCKED',
    );

    const suspendedRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: suspendedUser.email, password },
        ip,
      }),
    );
    expect(suspendedRes.status).toBe(403);
    expect(((await suspendedRes.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_SUSPENDED',
    );

    // Tài khoản `deleted` trả 401 INVALID_CREDENTIALS giống hệt sai email/mật khẩu.
    const deletedRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: deletedUser.email, password },
        ip,
      }),
    );
    expect(deletedRes.status).toBe(401);
    expect(((await deletedRes.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CREDENTIALS',
    );
  });

  it('Kiểm tra hạn không hoạt động (14 ngày) và hạn tuyệt đối (30 ngày) trên /refresh', async () => {
    const password = 'Cụm mật khẩu kiểm thử hạn phiên 2026!';
    const idleUser = await seedUser({ email: makeUniqueEmail('idle-timeout'), password });
    const absUser = await seedUser({ email: makeUniqueEmail('abs-timeout'), password });

    const ip1 = nextTestIp();
    const ip2 = nextTestIp();
    usedRateLimitIps.add(ip1);
    usedRateLimitIps.add(ip2);

    // 1. Hạn không hoạt động 14 ngày
    const idleLogin = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: idleUser.email, password },
        ip: ip1,
      }),
    );
    const idleJar = extractCookiesFromResponse(idleLogin);

    testClockMs += SESSION_IDLE_TTL_MS + 60_000;
    const idleRefresh = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: idleJar,
        includeCsrfHeader: true,
        ip: ip1,
      }),
    );
    expect(idleRefresh.status).toBe(401);

    // 2. Hạn tuyệt đối 30 ngày (dù vẫn refresh đều mỗi 10 ngày để không chạm idle 14 ngày)
    testClockMs = Date.now();
    const absLogin = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: absUser.email, password },
        ip: ip2,
      }),
    );
    let absJar = extractCookiesFromResponse(absLogin);

    // Ngày 10 -> OK
    testClockMs += 10 * 24 * 60 * 60 * 1000;
    const day10Res = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: absJar,
        includeCsrfHeader: true,
        ip: ip2,
      }),
    );
    expect(day10Res.status).toBe(200);
    absJar = extractCookiesFromResponse(day10Res, absJar);

    // Ngày 20 -> OK
    testClockMs += 10 * 24 * 60 * 60 * 1000;
    const day20Res = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: absJar,
        includeCsrfHeader: true,
        ip: ip2,
      }),
    );
    expect(day20Res.status).toBe(200);
    absJar = extractCookiesFromResponse(day20Res, absJar);

    // Ngày 30 + 1 phút -> vượt hạn tuyệt đối 30 ngày -> 401!
    testClockMs += SESSION_ABSOLUTE_TTL_MS - 20 * 24 * 60 * 60 * 1000 + 60_000;
    const day31Res = await refreshPost(
      makeJsonPostRequest('/api/v1/auth/refresh', {
        jar: absJar,
        includeCsrfHeader: true,
        ip: ip2,
      }),
    );
    expect(day31Res.status).toBe(401);
  });

  it('Bảo mật (PostgreSQL + Redis thật): Sai email vs sai mật khẩu trả thông báo giống hệt nhau và Rate Limit chặn 429 sau 10 lần/15p', async () => {
    const email = makeUniqueEmail('anti-enum-rl');
    const password = 'Cụm mật khẩu kiểm thử anti-enumeration 2026!';
    await seedUser({ email, password });

    const ip = nextTestIp();
    usedRateLimitIps.add(ip);

    const wrongEmailRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email: makeUniqueEmail('nonexistent'), password },
        ip,
      }),
    );
    const wrongPassRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email, password: 'Mật khẩu không đúng 2026!' },
        ip,
      }),
    );

    expect(wrongEmailRes.status).toBe(401);
    expect(wrongPassRes.status).toBe(401);
    const wrongEmailBody = await wrongEmailRes.json();
    const wrongPassBody = await wrongPassRes.json();
    expect(wrongEmailBody).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: AUTH_MESSAGES.invalidCredentials,
        details: [],
      },
    });
    expect(wrongPassBody).toEqual(wrongEmailBody);

    // Đã dùng 2 lượt từ `ip`, thêm 8 lượt nữa (tổng 10 lượt/15p) -> lượt thứ 11 phải bị chặn 429.
    for (let i = 0; i < 8; i += 1) {
      const attemptRes = await loginPost(
        makeJsonPostRequest('/api/v1/auth/login', {
          body: { email, password: 'Mật khẩu không đúng 2026!' },
          ip,
        }),
      );
      expect(attemptRes.status).toBe(401);
    }

    const eleventhRes = await loginPost(
      makeJsonPostRequest('/api/v1/auth/login', {
        body: { email, password },
        ip,
      }),
    );
    expect(eleventhRes.status).toBe(429);
    expect(Number(eleventhRes.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const rlBody = (await eleventhRes.json()) as { error: { code: string } };
    expect(rlBody.error.code).toBe('RATE_LIMITED');
  });
});
