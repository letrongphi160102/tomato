import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import {
  DELETE as blockDelete,
  POST as blockPost,
} from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { GET as blocksListGet } from '@/app/api/v1/social/blocks/route';
import {
  DELETE as unfollowDelete,
  POST as followPost,
} from '@/app/api/v1/social/follow/[userPublicId]/route';
import { POST as acceptRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/accept/route';
import { POST as declineRequestPost } from '@/app/api/v1/social/follow-requests/[userPublicId]/decline/route';
import { GET as followRequestsGet } from '@/app/api/v1/social/follow-requests/route';
import { DELETE as removeFollowerDelete } from '@/app/api/v1/social/followers/[userPublicId]/route';
import { GET as followersListGet } from '@/app/api/v1/social/users/[userPublicId]/followers/route';
import { GET as followingListGet } from '@/app/api/v1/social/users/[userPublicId]/following/route';
import { GET as userByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { GET as privacyGet, PATCH as privacyPatch } from '@/app/api/v1/users/me/privacy/route';
import { GET as searchUsersGet } from '@/app/api/v1/users/search/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { authIdentities, follows, users, type UserStatus } from '@/core/db/schema';
import { type EmailMessage, type EmailProvider } from '@/core/email';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
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
import {
  SocialRepository,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
} from '@/modules/social';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 30;
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

function makeMutate(
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

describe('Integration Phase 2 — M7: Follow State Machine, Tài khoản Riêng tư, Phân trang Keyset & Chặn Hai Chiều', () => {
  const createdUserIds: string[] = [];
  let currentClockMs: number;
  let rlPrefix: string;

  async function seedUser(params: {
    readonly email: string;
    readonly handle: string;
    readonly fullName: string;
    readonly password: string;
    readonly isPrivate?: boolean;
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
      isPrivate: params.isPrivate ?? false,
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
      makeMutate('POST', '/api/v1/auth/login', {
        body: { email, password },
        ip: nextTestIp(),
      }),
    );
    expect(res.status).toBe(200);
    return extractCookies(res);
  }

  function configureServices(options: { readonly privacyBatchSize?: number } = {}) {
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
    const socialRepo = new SocialRepository();
    const socialService = new SocialService({
      repository: socialRepo,
      rateLimiter,
      auditLogService,
      now: nowDate,
      privacyBatchSize: options.privacyBatchSize,
    });
    const profileService = new ProfileService({
      repository: new ProfileRepository(),
      socialRepository: socialRepo,
      rateLimiter,
      auditLogService,
      now: nowDate,
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setProfileServiceForTesting(profileService);
    setSocialServiceForTesting(socialService);
  }

  beforeEach(() => {
    currentClockMs = Date.now();
    rlPrefix = `tomato:test:m7int:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    configureServices();
  });

  afterAll(async () => {
    const db = getDb();
    for (const userId of createdUserIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    resetSocialServiceForTesting();
    resetProfileServiceForTesting();
    resetAuthServiceForTesting();
    resetSessionServiceForTesting();
    await closeRedisClient();
    await closeDatabasePool();
  });

  it('xác minh PostgreSQL có bảng follows & blocks kèm ràng buộc CHECK, UNIQUE và index đảo chiều', async () => {
    const db = getDb();

    const idxResult = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('follows', 'blocks')
        AND indexname IN (
          'uq_follows_follower_followee',
          'idx_follows_followee_status_created',
          'idx_follows_follower_status_created',
          'uq_blocks_blocker_blocked',
          'idx_blocks_blocked_blocker',
          'idx_blocks_blocker_created'
        )
    `);
    const indexNames = idxResult.rows.map((r) => String((r as { indexname: string }).indexname));
    expect(indexNames.sort()).toEqual([
      'idx_blocks_blocked_blocker',
      'idx_blocks_blocker_created',
      'idx_follows_followee_status_created',
      'idx_follows_follower_status_created',
      'uq_blocks_blocker_blocked',
      'uq_follows_follower_followee',
    ]);

    const chkResult = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('chk_follows_no_self_follow', 'chk_blocks_no_self_block')
    `);
    const conNames = chkResult.rows.map((r) => String((r as { conname: string }).conname));
    expect(conNames.sort()).toEqual(['chk_blocks_no_self_block', 'chk_follows_no_self_follow']);
  });

  it('Follow state machine cho tài khoản Công khai (idempotent, tự follow 400, đồng bộ bộ đếm) & Rate Limit 30 lần/giờ', async () => {
    const password = 'safe m7 public follow passphrase 2026';
    const tag = makeUniqueTag('pub');
    const a = await seedUser({
      email: `${tag}-a@tomato.test`,
      handle: `${tag}_a`,
      fullName: 'Alpha',
      password,
    });
    const b = await seedUser({
      email: `${tag}-b@tomato.test`,
      handle: `${tag}_b`,
      fullName: 'Beta',
      password,
    });
    const jarA = await loginAs(`${tag}-a@tomato.test`, password);

    // 1. Tự follow chính mình -> 400.
    const selfRes = await followPost(
      makeMutate('POST', `/api/v1/social/follow/${a.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(selfRes.status).toBe(400);

    // 2. A follow B -> following, bộ đếm tăng 1/1.
    const follow1 = await followPost(
      makeMutate('POST', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(follow1.status).toBe(200);
    const f1Json = (await follow1.json()) as {
      followStatus: string;
      followersCount: number;
      followingCount: number;
    };
    expect(f1Json.followStatus).toBe('following');
    expect(f1Json.followersCount).toBe(1);
    expect(f1Json.followingCount).toBe(1);

    // 3. Follow lại lần nữa (idempotent) -> không tăng gấp đôi.
    const follow2 = await followPost(
      makeMutate('POST', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(follow2.status).toBe(200);
    const f2Json = (await follow2.json()) as { followersCount: number; followingCount: number };
    expect(f2Json.followersCount).toBe(1);
    expect(f2Json.followingCount).toBe(1);

    // 4. Unfollow B -> none, bộ đếm về 0/0; unfollow lại idempotent không bị âm.
    const unfollow1 = await unfollowDelete(
      makeMutate('DELETE', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(unfollow1.status).toBe(200);
    const u1Json = (await unfollow1.json()) as {
      followStatus: string;
      followersCount: number;
      followingCount: number;
    };
    expect(u1Json.followStatus).toBe('none');
    expect(u1Json.followersCount).toBe(0);
    expect(u1Json.followingCount).toBe(0);

    const unfollow2 = await unfollowDelete(
      makeMutate('DELETE', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(unfollow2.status).toBe(200);

    // 5. Đã dùng 5/30 lượt Follow/Unfollow trong giờ -> thêm 25 lượt thành công, lượt thứ 31 bị 429 + Retry-After.
    for (let i = 0; i < 25; i += 1) {
      const res = await followPost(
        makeMutate('POST', `/api/v1/social/follow/${b.publicId}`, {
          jar: jarA,
          includeCsrf: true,
          ip: nextTestIp(),
        }),
        { params: Promise.resolve({ userPublicId: b.publicId }) },
      );
      expect(res.status).toBe(200);
    }

    const rateLimited = await unfollowDelete(
      makeMutate('DELETE', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(rateLimited.status).toBe(429);
    expect(Number(rateLimited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('Tài khoản Riêng tư: yêu cầu follow -> từ chối / chấp nhận -> xem danh sách -> gỡ follower & nhãn followedBy chỉ tính khi following', async () => {
    const password = 'safe m7 private account passphrase 2026';
    const tag = makeUniqueTag('prv');
    const a = await seedUser({
      email: `${tag}-a@tomato.test`,
      handle: `${tag}_a`,
      fullName: 'Private Owner',
      password,
    });
    const b = await seedUser({
      email: `${tag}-b@tomato.test`,
      handle: `${tag}_b`,
      fullName: 'Requester Bob',
      password,
    });
    await seedUser({
      email: `${tag}-d@tomato.test`,
      handle: `${tag}_d`,
      fullName: 'Stranger David',
      password,
    });

    const jarA = await loginAs(`${tag}-a@tomato.test`, password);
    const jarB = await loginAs(`${tag}-b@tomato.test`, password);
    const jarD = await loginAs(`${tag}-d@tomato.test`, password);

    // 1. A bật Tài khoản riêng tư.
    const setPrivRes = await privacyPatch(
      makeMutate('PATCH', '/api/v1/users/me/privacy', {
        body: { isPrivate: true },
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(setPrivRes.status).toBe(200);

    // 2. D (người lạ) xem profile A -> khung tối thiểu, xem followers/following -> 404.
    const dProf = await userByHandleGet(makeGet(`/api/v1/users/${a.handle}`, jarD, nextTestIp()), {
      params: Promise.resolve({ handle: a.handle }),
    });
    expect(dProf.status).toBe(200);
    const dProfJson = (await dProf.json()) as {
      profile: { isPrivate: boolean; canViewConnections: boolean; followStatus: string };
    };
    expect(dProfJson.profile.isPrivate).toBe(true);
    expect(dProfJson.profile.canViewConnections).toBe(false);

    const dListRes = await followersListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/followers`, jarD, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(dListRes.status).toBe(404);

    const dFollowingRes = await followingListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/following`, jarD, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(dFollowingRes.status).toBe(404);

    // 3. B gửi yêu cầu follow A -> requested, bộ đếm vẫn 0/0!
    const req1 = await followPost(
      makeMutate('POST', `/api/v1/social/follow/${a.publicId}`, {
        jar: jarB,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(req1.status).toBe(200);
    const req1Json = (await req1.json()) as {
      followStatus: string;
      followersCount: number;
      followingCount: number;
    };
    expect(req1Json.followStatus).toBe('requested');
    expect(req1Json.followersCount).toBe(0);
    expect(req1Json.followingCount).toBe(0);

    // Khi B chỉ mới gửi requested -> A xem trang của B phải thấy followedBy === false (không hiện "Theo dõi lại").
    const aViewsBWhileRequested = await userByHandleGet(
      makeGet(`/api/v1/users/${b.handle}`, jarA, nextTestIp()),
      { params: Promise.resolve({ handle: b.handle }) },
    );
    expect(aViewsBWhileRequested.status).toBe(200);
    const aViewsBJson = (await aViewsBWhileRequested.json()) as {
      profile: { followedBy: boolean };
    };
    expect(aViewsBJson.profile.followedBy).toBe(false);

    // Khi mới requested, B vẫn KHÔNG xem được danh sách followers của A (404).
    const bListPending = await followersListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/followers`, jarB, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(bListPending.status).toBe(404);

    // 4. A xem danh sách yêu cầu -> thấy B -> từ chối -> về none.
    const listReq1 = await followRequestsGet(
      makeGet('/api/v1/social/follow-requests', jarA, nextTestIp()),
    );
    expect(listReq1.status).toBe(200);
    const listReq1Json = (await listReq1.json()) as { items: Array<{ public_id: string }> };
    expect(listReq1Json.items.map((x) => x.public_id)).toEqual([b.publicId]);

    const declineRes = await declineRequestPost(
      makeMutate('POST', `/api/v1/social/follow-requests/${b.publicId}/decline`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(declineRes.status).toBe(200);

    // 5. B gửi yêu cầu lại -> A chấp nhận -> following, bộ đếm tăng 1/1!
    const req2 = await followPost(
      makeMutate('POST', `/api/v1/social/follow/${a.publicId}`, {
        jar: jarB,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(req2.status).toBe(200);

    const acceptRes = await acceptRequestPost(
      makeMutate('POST', `/api/v1/social/follow-requests/${b.publicId}/accept`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(acceptRes.status).toBe(200);
    const acceptJson = (await acceptRes.json()) as {
      followStatus: string;
      followersCount: number;
    };
    expect(acceptJson.followStatus).toBe('following');
    expect(acceptJson.followersCount).toBe(1);

    // Bây giờ A xem trang của B -> followedBy === true (đã là status = 'following')!
    const aViewsBAfterAccept = await userByHandleGet(
      makeGet(`/api/v1/users/${b.handle}`, jarA, nextTestIp()),
      { params: Promise.resolve({ handle: b.handle }) },
    );
    const aViewsBAfterJson = (await aViewsBAfterAccept.json()) as {
      profile: { followedBy: boolean };
    };
    expect(aViewsBAfterJson.profile.followedBy).toBe(true);

    // B (đã được duyệt) xem được followers của A (200); D (người lạ) vẫn 404!
    const bListApproved = await followersListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/followers`, jarB, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(bListApproved.status).toBe(200);

    const dListStill404 = await followersListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/followers`, jarD, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(dListStill404.status).toBe(404);

    // 6. A gỡ follower B -> bộ đếm về 0/0, B mất quyền xem danh sách của A (404).
    const removeRes = await removeFollowerDelete(
      makeMutate('DELETE', `/api/v1/social/followers/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(removeRes.status).toBe(200);
    const removeJson = (await removeRes.json()) as { removed: boolean; followersCount: number };
    expect(removeJson.removed).toBe(true);
    expect(removeJson.followersCount).toBe(0);

    const bListAfterRemove = await followersListGet(
      makeGet(`/api/v1/social/users/${a.publicId}/followers`, jarB, nextTestIp()),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    expect(bListAfterRemove.status).toBe(404);
  });

  it('chuyển Riêng tư -> Công khai xử lý theo từng lô nhỏ (batch) tự chấp nhận người active, dọn user suspended & tùy chọn xóa yêu cầu', async () => {
    // Cấu hình batchSize = 2 để xác minh xử lý đa lô (5 yêu cầu = 3 lô 2+2+1).
    configureServices({ privacyBatchSize: 2 });

    const password = 'safe m7 batch privacy passphrase 2026';
    const tag = makeUniqueTag('bat');
    const owner = await seedUser({
      email: `${tag}-owner@tomato.test`,
      handle: `${tag}_owner`,
      fullName: 'Batch Owner',
      password,
      isPrivate: true,
    });

    const requesters = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        seedUser({
          email: `${tag}-r${n}@tomato.test`,
          handle: `${tag}_r${n}`,
          fullName: `Requester ${n}`,
          password,
        }),
      ),
    );

    for (const r of requesters) {
      const jarR = await loginAs(`${tag}-r${requesters.indexOf(r) + 1}@tomato.test`, password);
      const res = await followPost(
        makeMutate('POST', `/api/v1/social/follow/${owner.publicId}`, {
          jar: jarR,
          includeCsrf: true,
          ip: nextTestIp(),
        }),
        { params: Promise.resolve({ userPublicId: owner.publicId }) },
      );
      expect(res.status).toBe(200);
    }

    // Đánh dấu requester thứ 5 thành suspended trước khi owner chuyển sang Công khai.
    await getDb()
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, requesters[4]!.userId));

    const jarOwner = await loginAs(`${tag}-owner@tomato.test`, password);

    const privGet = await privacyGet(makeGet('/api/v1/users/me/privacy', jarOwner, nextTestIp()));
    expect(privGet.status).toBe(200);
    const privGetJson = (await privGet.json()) as {
      privacy: { isPrivate: boolean; pendingFollowRequestsCount: number };
    };
    expect(privGetJson.privacy.isPrivate).toBe(true);
    expect(privGetJson.privacy.pendingFollowRequestsCount).toBe(4);

    // Chuyển Riêng tư -> Công khai với acceptPendingRequests = true.
    const toPublicRes = await privacyPatch(
      makeMutate('PATCH', '/api/v1/users/me/privacy', {
        body: { isPrivate: false, acceptPendingRequests: true },
        jar: jarOwner,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(toPublicRes.status).toBe(200);
    const toPublicJson = (await toPublicRes.json()) as {
      privacy: { isPrivate: boolean; pendingFollowRequestsCount: number };
      acceptedRequestsCount: number;
      followersCount: number;
    };
    expect(toPublicJson.privacy.isPrivate).toBe(false);
    expect(toPublicJson.privacy.pendingFollowRequestsCount).toBe(0);
    expect(toPublicJson.acceptedRequestsCount).toBe(4);
    expect(toPublicJson.followersCount).toBe(4);

    // Xác minh 4 requester active đều tăng following_count = 1, còn requester suspended không bị tăng & yêu cầu cũ đã dọn sạch.
    for (let i = 0; i < 4; i += 1) {
      const [row] = await getDb().select().from(users).where(eq(users.id, requesters[i]!.userId));
      expect(row?.followingCount).toBe(1);
    }
    const [suspendedRow] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, requesters[4]!.userId));
    expect(suspendedRow?.followingCount).toBe(0);

    // Kiểm tra chế độ acceptPendingRequests: false -> xóa sạch yêu cầu chờ, không tăng bộ đếm.
    await privacyPatch(
      makeMutate('PATCH', '/api/v1/users/me/privacy', {
        body: { isPrivate: true },
        jar: jarOwner,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    await seedUser({
      email: `${tag}-r6@tomato.test`,
      handle: `${tag}_r6`,
      fullName: 'Requester 6',
      password,
    });
    const jarR6 = await loginAs(`${tag}-r6@tomato.test`, password);
    await followPost(
      makeMutate('POST', `/api/v1/social/follow/${owner.publicId}`, {
        jar: jarR6,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: owner.publicId }) },
    );

    const discardRes = await privacyPatch(
      makeMutate('PATCH', '/api/v1/users/me/privacy', {
        body: { isPrivate: false, acceptPendingRequests: false },
        jar: jarOwner,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
    );
    expect(discardRes.status).toBe(200);
    const discardJson = (await discardRes.json()) as {
      acceptedRequestsCount: number;
      followersCount: number;
    };
    expect(discardJson.acceptedRequestsCount).toBe(0);
    expect(discardJson.followersCount).toBe(4);
  });

  it('Chặn hai chiều: cắt đồng thời follow & request 2 chiều, ẩn Search/Profile/Lists & cho phép bỏ chặn cả khi đối phương bị suspended', async () => {
    const password = 'safe m7 block flow passphrase 2026';
    const tag = makeUniqueTag('blk');
    const a = await seedUser({
      email: `${tag}-a@tomato.test`,
      handle: `${tag}_alice`,
      fullName: `Alice ${tag}`,
      password,
    });
    const b = await seedUser({
      email: `${tag}-b@tomato.test`,
      handle: `${tag}_bob`,
      fullName: `Bob ${tag}`,
      password,
    });
    const hub = await seedUser({
      email: `${tag}-hub@tomato.test`,
      handle: `${tag}_hub`,
      fullName: `Hub ${tag}`,
      password,
    });
    await seedUser({
      email: `${tag}-n@tomato.test`,
      handle: `${tag}_neutral`,
      fullName: `Neutral ${tag}`,
      password,
    });

    const jarA = await loginAs(`${tag}-a@tomato.test`, password);
    const jarB = await loginAs(`${tag}-b@tomato.test`, password);
    const jarN = await loginAs(`${tag}-n@tomato.test`, password);

    // Thiết lập: A <-> B follow lẫn nhau; cả A và B cùng follow Hub.
    await followPost(
      makeMutate('POST', `/api/v1/social/follow/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    await followPost(
      makeMutate('POST', `/api/v1/social/follow/${a.publicId}`, {
        jar: jarB,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: a.publicId }) },
    );
    await followPost(
      makeMutate('POST', `/api/v1/social/follow/${hub.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: hub.publicId }) },
    );
    await followPost(
      makeMutate('POST', `/api/v1/social/follow/${hub.publicId}`, {
        jar: jarB,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: hub.publicId }) },
    );

    // A chặn B -> tự động xóa cả 2 chiều A->B và B->A và đồng bộ bộ đếm trong 1 transaction!
    const blockRes = await blockPost(
      makeMutate('POST', `/api/v1/social/blocks/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    const [aRow] = await getDb().select().from(users).where(eq(users.id, a.userId));
    const [bRow] = await getDb().select().from(users).where(eq(users.id, b.userId));
    // A còn follow Hub (following=1, followers=0); B còn follow Hub (following=1, followers=0).
    expect(aRow?.followersCount).toBe(0);
    expect(aRow?.followingCount).toBe(1);
    expect(bRow?.followersCount).toBe(0);
    expect(bRow?.followingCount).toBe(1);

    // Ẩn hai chiều trên Search.
    const bSearchesA = await searchUsersGet(
      makeGet(`/api/v1/users/search?q=${encodeURIComponent(tag)}`, jarB, nextTestIp()),
    );
    const bSearchHandles = (
      (await bSearchesA.json()) as { items: Array<{ handle: string }> }
    ).items.map((i) => i.handle);
    expect(bSearchHandles).not.toContain(a.handle);

    const aSearchesB = await searchUsersGet(
      makeGet(`/api/v1/users/search?q=${encodeURIComponent(tag)}`, jarA, nextTestIp()),
    );
    const aSearchHandles = (
      (await aSearchesB.json()) as { items: Array<{ handle: string }> }
    ).items.map((i) => i.handle);
    expect(aSearchHandles).not.toContain(b.handle);

    // Ẩn hai chiều trên Profile & Lists (đồng nhất 404).
    const bProfileA = await userByHandleGet(
      makeGet(`/api/v1/users/${a.handle}`, jarB, nextTestIp()),
      {
        params: Promise.resolve({ handle: a.handle }),
      },
    );
    expect(bProfileA.status).toBe(404);

    const aProfileB = await userByHandleGet(
      makeGet(`/api/v1/users/${b.handle}`, jarA, nextTestIp()),
      {
        params: Promise.resolve({ handle: b.handle }),
      },
    );
    expect(aProfileB.status).toBe(404);

    // Trong danh sách followers của Hub: A không thấy B, B không thấy A, nhưng Neutral thấy cả 2.
    const aViewsHubFollowers = await followersListGet(
      makeGet(`/api/v1/social/users/${hub.publicId}/followers`, jarA, nextTestIp()),
      { params: Promise.resolve({ userPublicId: hub.publicId }) },
    );
    const aHubList = (
      (await aViewsHubFollowers.json()) as { items: Array<{ handle: string }> }
    ).items.map((i) => i.handle);
    expect(aHubList).toContain(a.handle);
    expect(aHubList).not.toContain(b.handle);

    const nViewsHubFollowers = await followersListGet(
      makeGet(`/api/v1/social/users/${hub.publicId}/followers`, jarN, nextTestIp()),
      { params: Promise.resolve({ userPublicId: hub.publicId }) },
    );
    const nHubList = (
      (await nViewsHubFollowers.json()) as { items: Array<{ handle: string }> }
    ).items.map((i) => i.handle);
    expect(nHubList).toContain(a.handle);
    expect(nHubList).toContain(b.handle);

    // Edge case: B bị suspended -> vẫn hiện trong GET /social/blocks của A và A vẫn bỏ chặn được!
    await getDb().update(users).set({ status: 'suspended' }).where(eq(users.id, b.userId));

    const blocksList = await blocksListGet(makeGet('/api/v1/social/blocks', jarA, nextTestIp()));
    expect(blocksList.status).toBe(200);
    const blocksJson = (await blocksList.json()) as { items: Array<{ public_id: string }> };
    expect(blocksJson.items.map((i) => i.public_id)).toEqual([b.publicId]);

    const unblockSuspendedRes = await blockDelete(
      makeMutate('DELETE', `/api/v1/social/blocks/${b.publicId}`, {
        jar: jarA,
        includeCsrf: true,
        ip: nextTestIp(),
      }),
      { params: Promise.resolve({ userPublicId: b.publicId }) },
    );
    expect(unblockSuspendedRes.status).toBe(200);

    // Khôi phục B về active -> hai bên nhìn thấy nhau trở lại nhưng KHÔNG tự khôi phục follow cũ.
    await getDb().update(users).set({ status: 'active' }).where(eq(users.id, b.userId));
    const aViewsBAgain = await userByHandleGet(
      makeGet(`/api/v1/users/${b.handle}`, jarA, nextTestIp()),
      {
        params: Promise.resolve({ handle: b.handle }),
      },
    );
    expect(aViewsBAgain.status).toBe(200);
    const aViewsBAgainJson = (await aViewsBAgain.json()) as {
      profile: { followStatus: string; followedBy: boolean };
    };
    expect(aViewsBAgainJson.profile.followStatus).toBe('none');
    expect(aViewsBAgainJson.profile.followedBy).toBe(false);
  });

  it('Phân trang keyset (created_at DESC, public_id DESC) không lặp/sót khi trùng timestamp, lọc q không tìm email & gọi đồng thời không lệch bộ đếm', async () => {
    const password = 'safe m7 keyset concurrency passphrase 2026';
    const tag = makeUniqueTag('ksp');
    const star = await seedUser({
      email: `${tag}-star@tomato.test`,
      handle: `${tag}_star`,
      fullName: 'Star Account',
      password,
    });
    const secretEmailToken = `hiddenmail${Date.now().toString(36)}`;

    const fans = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        seedUser({
          email: n === 1 ? `${secretEmailToken}@tomato.test` : `${tag}-f${n}@tomato.test`,
          handle: `${tag}_fan${n}`,
          fullName: `Fan Number ${n}`,
          password,
        }),
      ),
    );

    // Cố tình chèn 5 bản ghi follows có CÙNG MỘT timestamp `created_at` để kiểm tra tie-breaker `users.public_id DESC`.
    const identicalTimestamp = new Date('2026-11-23T12:00:00.123Z');
    const db = getDb();
    for (const fan of fans) {
      await db.insert(follows).values({
        id: generateUuidV7(),
        followerId: fan.userId,
        followeeId: star.userId,
        status: 'following',
        createdAt: identicalTimestamp,
        updatedAt: identicalTimestamp,
      });
    }
    await db.update(users).set({ followersCount: 5 }).where(eq(users.id, star.userId));

    const jarStar = await loginAs(`${tag}-star@tomato.test`, password);

    // 1. Duyệt hết 5 dòng với limit = 2 (3 trang: 2 + 2 + 1) -> đủ đúng 5 phần tử, không lặp, không sót, đúng thứ tự public_id DESC!
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res = await followersListGet(
        makeGet(`/api/v1/social/users/${star.publicId}/followers${qs}`, jarStar, nextTestIp()),
        { params: Promise.resolve({ userPublicId: star.publicId }) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ public_id: string }>;
        nextCursor: string | null;
      };
      for (const item of body.items) {
        collected.push(item.public_id);
      }
      cursor = body.nextCursor;
      if (!cursor) {
        break;
      }
    }

    const expectedOrder = fans.map((f) => f.publicId).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    expect(collected).toEqual(expectedOrder);

    // 2. Tham số `q` tìm được theo handle/fullName nhưng TUYỆT ĐỐI KHÔNG tìm theo email.
    const qHandleRes = await followersListGet(
      makeGet(`/api/v1/social/users/${star.publicId}/followers?q=fan3`, jarStar, nextTestIp()),
      { params: Promise.resolve({ userPublicId: star.publicId }) },
    );
    const qHandleJson = (await qHandleRes.json()) as { items: Array<{ handle: string }> };
    expect(qHandleJson.items.map((i) => i.handle)).toEqual([`${tag}_fan3`]);

    const qEmailRes = await followersListGet(
      makeGet(
        `/api/v1/social/users/${star.publicId}/followers?q=${encodeURIComponent(secretEmailToken)}`,
        jarStar,
        nextTestIp(),
      ),
      { params: Promise.resolve({ userPublicId: star.publicId }) },
    );
    const qEmailJson = (await qEmailRes.json()) as { items: unknown[] };
    expect(qEmailJson.items).toHaveLength(0);

    // 3. Stress concurrency: 2 người dùng gọi đồng thời Follow / Unfollow / Block -> không deadlock & bộ đếm khớp 100% COUNT(*).
    const c1 = await seedUser({
      email: `${tag}-c1@tomato.test`,
      handle: `${tag}_c1`,
      fullName: 'Conc 1',
      password,
    });
    const c2 = await seedUser({
      email: `${tag}-c2@tomato.test`,
      handle: `${tag}_c2`,
      fullName: 'Conc 2',
      password,
    });
    const jarC1 = await loginAs(`${tag}-c1@tomato.test`, password);
    const jarC2 = await loginAs(`${tag}-c2@tomato.test`, password);

    const parallelResults = await Promise.all([
      followPost(
        makeMutate('POST', `/api/v1/social/follow/${c2.publicId}`, {
          jar: jarC1,
          includeCsrf: true,
          ip: nextTestIp(),
        }),
        { params: Promise.resolve({ userPublicId: c2.publicId }) },
      ),
      followPost(
        makeMutate('POST', `/api/v1/social/follow/${c2.publicId}`, {
          jar: jarC1,
          includeCsrf: true,
          ip: nextTestIp(),
        }),
        { params: Promise.resolve({ userPublicId: c2.publicId }) },
      ),
      followPost(
        makeMutate('POST', `/api/v1/social/follow/${c1.publicId}`, {
          jar: jarC2,
          includeCsrf: true,
          ip: nextTestIp(),
        }),
        { params: Promise.resolve({ userPublicId: c1.publicId }) },
      ),
    ]);
    for (const res of parallelResults) {
      expect(res.status).toBe(200);
    }

    const [[c1Row], [c2Row], c1FollowersActual, c2FollowersActual] = await Promise.all([
      db.select().from(users).where(eq(users.id, c1.userId)),
      db.select().from(users).where(eq(users.id, c2.userId)),
      db
        .select({ c: sql<number>`CAST(COUNT(*) AS INTEGER)` })
        .from(follows)
        .where(and(eq(follows.followeeId, c1.userId), eq(follows.status, 'following'))),
      db
        .select({ c: sql<number>`CAST(COUNT(*) AS INTEGER)` })
        .from(follows)
        .where(and(eq(follows.followeeId, c2.userId), eq(follows.status, 'following'))),
    ]);

    expect(c1Row?.followersCount).toBe(Number(c1FollowersActual[0]?.c ?? 0));
    expect(c2Row?.followersCount).toBe(Number(c2FollowersActual[0]?.c ?? 0));
    expect(c1Row?.followingCount).toBe(1);
    expect(c2Row?.followingCount).toBe(1);
  });
});
