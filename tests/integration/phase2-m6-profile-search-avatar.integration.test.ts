import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as registerPost } from '@/app/api/v1/auth/register/route';
import { GET as localAvatarGet } from '@/app/api/v1/media/local/avatars/[fileName]/route';
import { GET as userByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { DELETE as avatarDelete, POST as avatarPost } from '@/app/api/v1/users/me/avatar/route';
import {
  GET as ownProfileGet,
  PATCH as ownProfilePatch,
} from '@/app/api/v1/users/me/profile/route';
import { GET as searchUsersGet } from '@/app/api/v1/users/search/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { authIdentities, userHandleHistory, users, type UserStatus } from '@/core/db/schema';
import { type EmailMessage, type EmailProvider } from '@/core/email';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  LocalFsStorageAdapter,
  resetMediaStorageProviderForTesting,
  setMediaStorageProviderForTesting,
} from '@/core/storage';
import {
  AuthRepository,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';
import {
  ProfileRepository,
  ProfileService,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
} from '@/modules/profile';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 10;
function nextTestIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 200) + 10}`;
}

function makeUniqueTag(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class SilentEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
}

function extractCookies(response: Response, previous: CookieJar = {}): CookieJar {
  const next: CookieJar = { ...previous };
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(';')[0] ?? '';
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();
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

function buildCookieHeader(jar: CookieJar): string {
  const parts: string[] = [];
  if (jar.at) parts.push(`tomato_at=${jar.at}`);
  if (jar.rt) parts.push(`tomato_rt=${jar.rt}`);
  if (jar.csrf) parts.push(`tomato_csrf=${jar.csrf}`);
  return parts.join('; ');
}

function makeGet(urlPath: string, jar: CookieJar, ip: string): Request {
  return new Request(`${getTestOrigin()}${urlPath}`, {
    method: 'GET',
    headers: {
      cookie: buildCookieHeader(jar),
      'x-forwarded-for': ip,
    },
  });
}

function makeJsonMutate(
  method: 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  options: {
    readonly body?: unknown;
    readonly jar?: CookieJar;
    readonly includeCsrf?: boolean;
    readonly ip: string;
  },
): Request {
  const headers = new Headers({
    origin: getTestOrigin(),
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': options.ip,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
  });
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (options.jar) {
    const cookie = buildCookieHeader(options.jar);
    if (cookie) headers.set('cookie', cookie);
    if (options.includeCsrf && options.jar.csrf) {
      headers.set(CSRF_HEADER_NAME, options.jar.csrf);
    }
  }

  return new Request(`${getTestOrigin()}${urlPath}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

function makeMultipartPost(
  urlPath: string,
  options: {
    readonly fileBuffer: Buffer;
    readonly fileName: string;
    readonly mimeType: string;
    readonly jar: CookieJar;
    readonly ip: string;
  },
): Request {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(options.fileBuffer)], { type: options.mimeType });
  formData.append('file', blob, options.fileName);

  const headers = new Headers({
    origin: getTestOrigin(),
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': options.ip,
    cookie: buildCookieHeader(options.jar),
  });
  if (options.jar.csrf) {
    headers.set(CSRF_HEADER_NAME, options.jar.csrf);
  }

  return new Request(`${getTestOrigin()}${urlPath}`, {
    method: 'POST',
    headers,
    body: formData,
  });
}

async function createSampleImageBuffer(format: 'png' | 'jpeg'): Promise<Buffer> {
  const img = sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: format === 'png' ? { r: 230, g: 70, b: 60 } : { r: 40, g: 130, b: 220 },
    },
  });
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 90 }).toBuffer();
}

describe('Integration Phase 2 — M6: Hồ sơ (@handle), Tìm kiếm pg_trgm & Ảnh đại diện (Sharp)', () => {
  const createdUserIds: string[] = [];
  let storageDir: string;
  let storageAdapter: LocalFsStorageAdapter;
  let currentClockMs: number;
  let rlPrefix: string;

  async function seedUser(params: {
    readonly email: string;
    readonly handle: string;
    readonly fullName: string;
    readonly password: string;
    readonly status?: UserStatus;
  }): Promise<{ readonly userId: string; readonly publicId: string; readonly handle: string }> {
    const db = getDb();
    const userId = generateUuidV7();
    const publicId = generatePublicId();
    const identityId = generateUuidV7();
    const { hash, pepperVersion } = await hashPassword(params.password);
    const now = new Date(currentClockMs);

    await db.insert(users).values({
      id: userId,
      publicId,
      username: params.handle,
      handle: params.handle,
      handleNormalized: params.handle,
      fullName: params.fullName,
      gender: 'other',
      dateOfBirth: '1998-06-15',
      status: params.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    });
    createdUserIds.push(userId);

    await db.insert(authIdentities).values({
      id: identityId,
      userId,
      provider: 'email_password',
      identifierNormalized: params.email.toLowerCase(),
      passwordHash: hash,
      pepperVersion,
      verifiedAt: params.status === 'pending_verification' ? null : now,
      createdAt: now,
      updatedAt: now,
    });

    return { userId, publicId, handle: params.handle };
  }

  async function loginAs(email: string, password: string): Promise<CookieJar> {
    const res = await loginPost(
      makeJsonMutate('POST', '/api/v1/auth/login', {
        body: { email, password },
        ip: nextTestIp(),
      }),
    );
    expect(res.status).toBe(200);
    return extractCookies(res);
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'tomato-m6-int-'));
    storageAdapter = new LocalFsStorageAdapter(storageDir);
  });

  beforeEach(() => {
    currentClockMs = Date.now();
    rlPrefix = `tomato:test:m6int:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;

    const redis = getRedisClient();
    const nowDate = () => new Date(currentClockMs);
    const rateLimiter = new RateLimiter(redis, {
      keyPrefix: rlPrefix,
      now: () => currentClockMs,
    });
    const loginProtection = new LoginBruteForceGuard(redis, {
      keyPrefix: `${rlPrefix}:bf`,
      now: () => currentClockMs,
    });
    const authRepo = new AuthRepository();
    const auditLogService = new AuditLogService();
    const sessionService = new SessionService({
      repository: authRepo,
      rateLimiter,
      auditLogService,
      now: nowDate,
    });
    const authService = new AuthService({
      repository: authRepo,
      sessionService,
      rateLimiter,
      loginProtection,
      emailProvider: new SilentEmailProvider(),
      captchaProvider: {
        provider: 'turnstile',
        verify: async () => ({ success: true, errorCodes: [] }),
      },
      auditLogService,
      now: nowDate,
      minLoginFailureResponseMs: 0,
      minResendResponseMs: 0,
    });
    const profileService = new ProfileService({
      repository: new ProfileRepository(),
      rateLimiter,
      storageProvider: storageAdapter,
      auditLogService,
      now: nowDate,
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setProfileServiceForTesting(profileService);
    setMediaStorageProviderForTesting(storageAdapter);
  });

  afterAll(async () => {
    const db = getDb();
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    resetProfileServiceForTesting();
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();
    resetMediaStorageProviderForTesting();
    await rm(storageDir, { recursive: true, force: true });
    await closeRedisClient();
    await closeDatabasePool();
  });

  it('xác minh PostgreSQL có extension pg_trgm, bảng user_handle_history và đủ 3 index hồ sơ', async () => {
    const db = getDb();

    const extResult = await db.execute(
      sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(extResult.rows.length).toBe(1);

    const idxResult = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname IN ('idx_users_handle_norm', 'idx_users_handle_prefix', 'idx_users_full_name_trgm')`,
    );
    const indexNames = idxResult.rows.map((r) => String((r as { indexname: string }).indexname));
    expect(indexNames.sort()).toEqual([
      'idx_users_full_name_trgm',
      'idx_users_handle_norm',
      'idx_users_handle_prefix',
    ]);
  });

  it('đổi @handle giữ chỗ 14 ngày (chặn user khác đổi & đăng ký trùng), giới hạn 2 lần/14 ngày và mở khóa sau ngày thứ 15', async () => {
    const password = 'safe m6 profile passphrase 2026';
    const tag = makeUniqueTag('h');
    const handleA1 = `${tag}_a1`;
    const handleA2 = `${tag}_a2`;
    const handleA3 = `${tag}_a3`;
    const handleA4 = `${tag}_a4`;
    const handleB1 = `${tag}_b1`;
    const emailA = `${tag}-a@tomato.test`;
    const emailB = `${tag}-b@tomato.test`;

    const userA = await seedUser({
      email: emailA,
      handle: handleA1,
      fullName: 'Alice M6',
      password,
    });
    await seedUser({ email: emailB, handle: handleB1, fullName: 'Bob M6', password });

    const jarA = await loginAs(emailA, password);

    // 1. User A đổi handle lần 1 + cập nhật bio & fullName.
    const change1Res = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: {
          handle: `@${handleA2.toUpperCase()}`,
          fullName: 'Alice Đã Đổi Tên',
          bio: 'Yêu thích nhiếp ảnh và cà phê.',
        },
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(change1Res.status).toBe(200);
    const change1Json = (await change1Res.json()) as {
      profile: {
        handle: string;
        fullName: string;
        bio: string;
        handleChangesRemaining: number;
      };
    };
    expect(change1Json.profile.handle).toBe(handleA2);
    expect(change1Json.profile.fullName).toBe('Alice Đã Đổi Tên');
    expect(change1Json.profile.bio).toBe('Yêu thích nhiếp ảnh và cà phê.');
    expect(change1Json.profile.handleChangesRemaining).toBe(1);

    // Xác minh bảng user_handle_history đã ghi nhận giữ chỗ 14 ngày cho handle cũ.
    const historyRows = await getDb()
      .select()
      .from(userHandleHistory)
      .where(eq(userHandleHistory.userId, userA.userId));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.oldHandleNormalized).toBe(handleA1);

    // 2. Trong ngày thứ 5, User B cố chiếm handle cũ `handleA1` -> bị chặn 409 CONFLICT.
    // (Sau khi tua đồng hồ 5 ngày, Access Token 15 phút hết hạn -> đăng nhập lại phiên mới cho cả A và B).
    currentClockMs += 5 * 24 * 60 * 60 * 1000;
    const jarADay5 = await loginAs(emailA, password);
    const jarBDay5 = await loginAs(emailB, password);
    const stealByPatchRes = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleA1 },
        jar: jarBDay5,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(stealByPatchRes.status).toBe(409);

    // 3. Trong ngày thứ 5, tài khoản mới cố đăng ký chiếm `handleA1` -> bị chặn 409 CONFLICT.
    const stealByRegisterRes = await registerPost(
      makeJsonMutate('POST', '/api/v1/auth/register', {
        body: {
          fullName: 'Newcomer Test',
          username: handleA1,
          gender: 'male',
          email: `${tag}-steal@tomato.test`,
          password: 'brand new safe passphrase 2026',
          dateOfBirth: '1999-05-05',
          acceptedTerms: true,
          captchaToken: 'dummy-captcha-token',
        },
        ip: nextTestIp(),
      }),
    );
    expect(stealByRegisterRes.status).toBe(409);

    // 4. User A đổi lần 2 trong cùng cửa sổ 14 ngày -> thành công, còn 0 lượt.
    const change2Res = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleA3 },
        jar: jarADay5,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(change2Res.status).toBe(200);
    const change2Json = (await change2Res.json()) as {
      profile: {
        handle: string;
        handleChangesRemaining: number;
        nextHandleChangeAvailableAt: string | null;
      };
    };
    expect(change2Json.profile.handle).toBe(handleA3);
    expect(change2Json.profile.handleChangesRemaining).toBe(0);
    expect(change2Json.profile.nextHandleChangeAvailableAt).toBeTruthy();

    // 5. User A cố đổi lần 3 trong 14 ngày -> bị chặn 429 RATE_LIMITED + Retry-After.
    const change3Res = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleA4 },
        jar: jarADay5,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(change3Res.status).toBe(429);
    expect(Number(change3Res.headers.get('Retry-After'))).toBeGreaterThan(0);

    // 6. Sang ngày thứ 15 (quá hạn giữ chỗ 14 ngày của `handleA1`) -> User B lấy được `handleA1`!
    currentClockMs += 10 * 24 * 60 * 60 * 1000;
    const freshJarB = await loginAs(emailB, password);
    const claimExpiredRes = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleA1 },
        jar: freshJarB,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(claimExpiredRes.status).toBe(200);
    const claimExpiredJson = (await claimExpiredRes.json()) as { profile: { handle: string } };
    expect(claimExpiredJson.profile.handle).toBe(handleA1);

    // 7. Chính chủ được quyền quay lại chính handle cũ của mình đang trong thời hạn giữ chỗ 14 ngày.
    const handleC1 = `${tag}_c1`;
    const handleC2 = `${tag}_c2`;
    const emailC = `${tag}-c@tomato.test`;
    await seedUser({ email: emailC, handle: handleC1, fullName: 'User C Reclaim', password });
    const jarC = await loginAs(emailC, password);
    const cStep1 = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleC2 },
        jar: jarC,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(cStep1.status).toBe(200);
    const cReclaim = await ownProfilePatch(
      makeJsonMutate('PATCH', '/api/v1/users/me/profile', {
        body: { handle: handleC1 },
        jar: jarC,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(cReclaim.status).toBe(200);

    // 8. GET /api/v1/users/me/profile và GET /api/v1/users/:handle phản ánh chính xác.
    const ownGetRes = await ownProfileGet(
      makeGet('/api/v1/users/me/profile', freshJarB, nextTestIp()),
    );
    expect(ownGetRes.status).toBe(200);
    const publicGetRes = await userByHandleGet(
      makeGet(`/api/v1/users/${handleA3}`, freshJarB, nextTestIp()),
      { params: Promise.resolve({ handle: handleA3 }) },
    );
    expect(publicGetRes.status).toBe(200);
    const publicGetJson = (await publicGetRes.json()) as {
      profile: { handle: string; isOwnProfile: boolean };
    };
    expect(publicGetJson.profile.handle).toBe(handleA3);
    expect(publicGetJson.profile.isOwnProfile).toBe(false);
  });

  it('tìm kiếm ưu tiên exact > prefix @handle > tên hiển thị, không tìm theo email, lọc user không active & rate limit 30 req/phút', async () => {
    const password = 'safe m6 search passphrase 2026';
    const prefix = `zq${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    const searcherEmail = `${prefix}-viewer@tomato.test`;
    const secretEmailToken = `secretmail${Date.now().toString(36)}`;

    await seedUser({
      email: searcherEmail,
      handle: `${prefix}_viewer`,
      fullName: 'Người Tìm Kiếm',
      password,
    });
    // Exact handle match
    await seedUser({
      email: `${secretEmailToken}@tomato.test`,
      handle: prefix,
      fullName: 'Trần Khớp Chính Xác',
      password,
    });
    // Prefix handle match
    await seedUser({
      email: `${prefix}-pref@tomato.test`,
      handle: `${prefix}_alpha`,
      fullName: 'Lê Tiền Tố',
      password,
    });
    // Display name match (handle không chứa prefix)
    await seedUser({
      email: `${prefix}-name@tomato.test`,
      handle: `other_${Date.now().toString(36).slice(-5)}`,
      fullName: `Phạm ${prefix} Display`,
      password,
    });
    // Tài khoản chưa xác minh & bị khóa -> phải bị ẩn khỏi tìm kiếm và xem hồ sơ (404).
    const pendingHandle = `${prefix}_pending`;
    const suspendedHandle = `${prefix}_suspended`;
    await seedUser({
      email: `${prefix}-pending@tomato.test`,
      handle: pendingHandle,
      fullName: 'Chưa Xác Minh',
      password,
      status: 'pending_verification',
    });
    await seedUser({
      email: `${prefix}-suspended@tomato.test`,
      handle: suspendedHandle,
      fullName: 'Bị Đình Chỉ',
      password,
      status: 'suspended',
    });

    const jar = await loginAs(searcherEmail, password);

    // 1. Tìm với dấu `@` đầu: xếp hạng exact -> prefix -> tên hiển thị, ẩn pending & suspended.
    const searchRes = await searchUsersGet(
      makeGet(`/api/v1/users/search?q=${encodeURIComponent(`@${prefix}`)}`, jar, nextTestIp()),
    );
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as {
      items: Array<{ handle: string; fullName: string }>;
    };
    const returnedHandles = searchJson.items.map((item) => item.handle);
    expect(returnedHandles[0]).toBe(prefix);
    expect(returnedHandles).toContain(`${prefix}_alpha`);
    expect(returnedHandles).not.toContain(pendingHandle);
    expect(returnedHandles).not.toContain(suspendedHandle);

    // 2. Tuyệt đối KHÔNG tìm theo email.
    const emailSearchRes = await searchUsersGet(
      makeGet(`/api/v1/users/search?q=${encodeURIComponent(secretEmailToken)}`, jar, nextTestIp()),
    );
    expect(emailSearchRes.status).toBe(200);
    const emailSearchJson = (await emailSearchRes.json()) as { items: unknown[] };
    expect(emailSearchJson.items).toHaveLength(0);

    // 3. Xem hồ sơ user pending/suspended trả 404 đồng nhất.
    const pendingProfileRes = await userByHandleGet(
      makeGet(`/api/v1/users/${pendingHandle}`, jar, nextTestIp()),
      { params: Promise.resolve({ handle: pendingHandle }) },
    );
    expect(pendingProfileRes.status).toBe(404);

    // 4. Rate limit tìm kiếm: 30 req/phút/user (đã gọi 2 lần ở trên -> thêm 28 lần thành công, lần 31 trả 429).
    for (let i = 0; i < 28; i += 1) {
      const ok = await searchUsersGet(
        makeGet(`/api/v1/users/search?q=${prefix}`, jar, nextTestIp()),
      );
      expect(ok.status).toBe(200);
    }
    const rateLimitedRes = await searchUsersGet(
      makeGet(`/api/v1/users/search?q=${prefix}`, jar, nextTestIp()),
    );
    expect(rateLimitedRes.status).toBe(429);
    expect(Number(rateLimitedRes.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('tải lên, thay thế (xóa file cũ), chặn SVG giả mạo, gỡ ảnh đại diện và cưỡng chế rate limit 5 lần/giờ', async () => {
    const password = 'safe m6 avatar passphrase 2026';
    const tag = makeUniqueTag('av');
    const email = `${tag}@tomato.test`;
    const seeded = await seedUser({ email, handle: tag, fullName: 'Avatar Tester', password });
    const jar = await loginAs(email, password);

    const pngBuf = await createSampleImageBuffer('png');
    const jpgBuf = await createSampleImageBuffer('jpeg');

    // 1. Upload PNG hợp lệ -> lưu WebP 512x512 và phục vụ qua route local media.
    const upload1Res = await avatarPost(
      makeMultipartPost('/api/v1/users/me/avatar', {
        fileBuffer: pngBuf,
        fileName: 'photo.png',
        mimeType: 'image/png',
        jar,
        ip: nextTestIp(),
      }),
    );
    expect(upload1Res.status).toBe(200);
    const upload1Json = (await upload1Res.json()) as { avatarUrl: string };
    expect(upload1Json.avatarUrl).toMatch(/^\/api\/v1\/media\/local\/avatars\/[a-f0-9]{32}\.webp$/);

    const file1Name = upload1Json.avatarUrl.split('/').pop()!;
    const serve1Res = await localAvatarGet(
      new Request(`${getTestOrigin()}${upload1Json.avatarUrl}`),
      { params: Promise.resolve({ fileName: file1Name }) },
    );
    expect(serve1Res.status).toBe(200);
    const servedBytes = Buffer.from(await serve1Res.arrayBuffer());
    const detected = await fileTypeFromBuffer(servedBytes);
    expect(detected?.mime).toBe('image/webp');
    const meta = await sharp(servedBytes).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);

    // 2. Upload ảnh thứ 2 -> cập nhật URL mới VÀ xóa file ảnh cũ khỏi đĩa.
    const upload2Res = await avatarPost(
      makeMultipartPost('/api/v1/users/me/avatar', {
        fileBuffer: jpgBuf,
        fileName: 'new.jpg',
        mimeType: 'image/jpeg',
        jar,
        ip: nextTestIp(),
      }),
    );
    expect(upload2Res.status).toBe(200);
    const upload2Json = (await upload2Res.json()) as { avatarUrl: string };
    expect(upload2Json.avatarUrl).not.toBe(upload1Json.avatarUrl);

    // File cũ phải bị xóa hoàn toàn.
    expect(await storageAdapter.readObject(`avatars/${file1Name}`)).toBeNull();

    // 3. Upload SVG giả đuôi .jpg -> bị từ chối 400 VALIDATION_ERROR (tốn 1 lượt RL thứ 3).
    const svgRes = await avatarPost(
      makeMultipartPost('/api/v1/users/me/avatar', {
        fileBuffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
        fileName: 'fake.jpg',
        mimeType: 'image/jpeg',
        jar,
        ip: nextTestIp(),
      }),
    );
    expect(svgRes.status).toBe(400);

    // 4. Thực hiện tiếp lượt 4 & 5 thành công -> lượt 6 bị chặn 429 RATE_LIMITED (5 lần/giờ).
    for (let i = 0; i < 2; i += 1) {
      const res = await avatarPost(
        makeMultipartPost('/api/v1/users/me/avatar', {
          fileBuffer: pngBuf,
          fileName: `avatar-${i}.png`,
          mimeType: 'image/png',
          jar,
          ip: nextTestIp(),
        }),
      );
      expect(res.status).toBe(200);
    }

    const sixthRes = await avatarPost(
      makeMultipartPost('/api/v1/users/me/avatar', {
        fileBuffer: pngBuf,
        fileName: 'sixth.png',
        mimeType: 'image/png',
        jar,
        ip: nextTestIp(),
      }),
    );
    expect(sixthRes.status).toBe(429);

    // 5. Gỡ ảnh đại diện -> xóa file trên đĩa & xóa avatarUrl/avatarStorageKey trong DB.
    const [beforeDeleteRow] = await getDb().select().from(users).where(eq(users.id, seeded.userId));
    expect(beforeDeleteRow?.avatarStorageKey).toBeTruthy();

    const deleteRes = await avatarDelete(
      makeJsonMutate('DELETE', '/api/v1/users/me/avatar', {
        jar,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(deleteRes.status).toBe(200);

    const [afterDeleteRow] = await getDb().select().from(users).where(eq(users.id, seeded.userId));
    expect(afterDeleteRow?.avatarUrl).toBeNull();
    expect(afterDeleteRow?.avatarStorageKey).toBeNull();
    if (beforeDeleteRow?.avatarStorageKey) {
      expect(await storageAdapter.readObject(beforeDeleteRow.avatarStorageKey)).toBeNull();
    }
  });
});
