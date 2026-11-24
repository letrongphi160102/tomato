import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockNotFound, mockRedirect, mockResolveServerAuthState } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn((target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  }),
  mockResolveServerAuthState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
}));

vi.mock('@/modules/auth/server-session', () => ({
  resolveServerAuthState: mockResolveServerAuthState,
}));

import UserProfilePage, {
  generateMetadata as generateUserProfileMetadata,
} from '@/app/(dashboard)/u/[handle]/page';
import { POST as pinResetConfirmPost } from '@/app/api/v1/e2ee/backup/reset/confirm/route';
import { POST as pinResetRequestPost } from '@/app/api/v1/e2ee/backup/reset/request/route';
import { GET as e2eeBackupGet, PUT as e2eeBackupPut } from '@/app/api/v1/e2ee/backup/route';
import { GET as userProfileByHandleGet } from '@/app/api/v1/users/[handle]/route';
import { getEnv } from '@/core/config/env';
import type { DatabaseTransaction } from '@/core/db';
import type {
  SessionRow,
  UserE2eeDeviceRow,
  UserE2eeKeyBackupRow,
  UserRow,
} from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import { InMemoryRealtimeAdapter } from '@/core/realtime';
import { InMemoryPinResetOtpStore } from '@/core/redis';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import {
  clearMemoryKeystoreForTesting,
  createPinProtectedKeyBackup,
  reEncryptPinProtectedKeyBackup,
} from '@/lib/e2ee';
import {
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  ChatService,
  resetChatServiceForTesting,
  setChatServiceForTesting,
  type ChatRepository,
} from '@/modules/chat';
import {
  ProfileService,
  resetProfileServiceForTesting,
  setProfileServiceForTesting,
  type ProfileRepository,
} from '@/modules/profile';
import type { SocialRelationshipSnapshot } from '@/modules/social/social.policy';
import type { SocialRepository } from '@/modules/social/social.repository';
import { proxy } from '@/proxy';

const TEST_CSRF = 'synthetic-csrf-token-profile-pin-security';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-24T12:00:00.000Z');
  return {
    id: '0195c000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    username: 'alice_sec',
    handle: 'alice_sec',
    handleNormalized: 'alice_sec',
    fullName: 'Alice Bảo Mật',
    bio: 'Tiểu sử riêng tư của Alice',
    avatarUrl: 'https://cdn.tomato.test/alice.webp',
    avatarStorageKey: 'avatars/alice.webp',
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 10,
    followingCount: 5,
    handleChangedAt: null,
    gender: 'female',
    dateOfBirth: '1999-05-10',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(user: UserRow): AuthenticatedPrincipal {
  const now = new Date('2026-11-24T12:00:00.000Z');
  const session: SessionRow = {
    id: '0195c000-0000-7000-8000-000000000090',
    publicId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: user.id,
    familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    refreshTokenHash: 'synthetic-hash',
    deviceInfo: 'Chrome on Windows',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  };
  return { user, session };
}

function createAuthHeaders(origin: string, accessToken: string, includeCsrf = true) {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `tomato_at=${accessToken}; tomato_csrf=${TEST_CSRF}`,
    'Content-Type': 'application/json',
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

function extractSixDigitOtpFromEmail(message: EmailMessage): string {
  const match = message.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) {
    throw new Error('Không tìm thấy mã OTP 6 chữ số trong nội dung email test');
  }
  return match[1];
}

afterEach(() => {
  resetSessionServiceForTesting();
  resetChatServiceForTesting();
  resetProfileServiceForTesting();
  clearMemoryKeystoreForTesting();
  vi.restoreAllMocks();
});

describe('Security Phần 1: Chia sẻ liên kết trang cá nhân & Chặn 2 chiều (404 đồng nhất)', () => {
  const alice = makeUserRow({
    id: '0195c000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
    handle: 'alice_share',
    handleNormalized: 'alice_share',
    username: 'alice_share',
  });
  const bob = makeUserRow({
    id: '0195c000-0000-7000-8000-000000000002',
    publicId: '22222222-2222-4222-8222-222222222222',
    handle: 'bob_viewer',
    handleNormalized: 'bob_viewer',
    username: 'bob_viewer',
  });

  function setupProfileBlockEnv(relationship: SocialRelationshipSnapshot) {
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn(async (token?: string) => {
        if (token === 'tok-bob') return makePrincipal(bob);
        if (token === 'tok-alice') return makePrincipal(alice);
        throw new Error('Unauthorized');
      }),
    } as unknown as SessionService);

    const profileRepo = {
      findUserByHandleNormalized: vi.fn(async (h: string) =>
        h === alice.handleNormalized ? alice : null,
      ),
    } as unknown as ProfileRepository;

    const socialRepo = {
      getRelationshipSnapshot: vi.fn(async () => relationship),
    } as unknown as SocialRepository;

    const rateLimiter = {
      consume: vi.fn(async () => ({
        allowed: true,
        limit: 60,
        remaining: 59,
        resetAt: Date.now() + 60_000,
        retryAfterSeconds: 0,
      })),
    };

    setProfileServiceForTesting(
      new ProfileService({
        repository: profileRepo,
        socialRepository: socialRepo,
        rateLimiter: rateLimiter as never,
      }),
    );
  }

  it('A chặn B hoặc B chặn A -> mở trực tiếp GET /api/v1/users/[handle], SSR UserProfilePage và generateMetadata đều trả 404 / tiêu đề trung tính, không lộ hồ sơ', async () => {
    const origin = getTestOrigin();

    for (const rel of [
      {
        blockedByActor: false,
        blockedByTarget: true,
        actorFollowStatus: 'none' as const,
        targetFollowStatus: 'none' as const,
      },
      {
        blockedByActor: true,
        blockedByTarget: false,
        actorFollowStatus: 'none' as const,
        targetFollowStatus: 'none' as const,
      },
    ]) {
      setupProfileBlockEnv(rel);

      // 1. API GET /api/v1/users/[handle] -> 404 sạch.
      const res = await userProfileByHandleGet(
        new Request(`${origin}/api/v1/users/alice_share`, {
          headers: createAuthHeaders(origin, 'tok-bob', false),
        }),
        { params: Promise.resolve({ handle: 'alice_share' }) },
      );

      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe(AUTH_CACHE_CONTROL_HEADER);
      const rawBody = await res.text();
      expect(rawBody).not.toContain('Alice Bảo Mật');
      expect(rawBody).not.toContain('Tiểu sử riêng tư');
      expect(rawBody).not.toContain(alice.publicId);

      // 2. SSR generateMetadata & UserProfilePage khi Bob mở trực tiếp liên kết `/u/alice_share` -> không rò rỉ handle/tên/ảnh/tiểu sử và gọi `notFound()` (404).
      mockResolveServerAuthState.mockResolvedValue({
        status: 'authenticated',
        principal: makePrincipal(bob),
        user: {
          public_id: bob.publicId,
          username: bob.username,
          fullName: bob.fullName,
        },
        profile: { handle: bob.handle, avatarUrl: bob.avatarUrl },
        accessTokenRemainingMs: 600_000,
      });

      const blockedMeta = await generateUserProfileMetadata({
        params: Promise.resolve({ handle: 'alice_share' }),
      });
      expect(blockedMeta.title).toBe('Trang không khả dụng — Tomato');
      expect(JSON.stringify(blockedMeta)).not.toContain('alice_share');
      expect(JSON.stringify(blockedMeta)).not.toContain('Alice Bảo Mật');
      expect(JSON.stringify(blockedMeta)).not.toContain('Tiểu sử riêng tư');

      await expect(
        UserProfilePage({
          params: Promise.resolve({ handle: 'alice_share' }),
        }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
    }

    // 3. Khi chưa đăng nhập mở liên kết `/u/alice_share` -> generateMetadata cũng tuyệt đối không lộ handle/tên.
    mockResolveServerAuthState.mockResolvedValue({ status: 'unauthenticated' });
    const unauthMeta = await generateUserProfileMetadata({
      params: Promise.resolve({ handle: 'alice_share' }),
    });
    expect(unauthMeta.title).toBe('Trang không khả dụng — Tomato');
    expect(JSON.stringify(unauthMeta)).not.toContain('alice_share');

    // 4. Khi KHÔNG bị chặn -> generateMetadata trả `@alice_share — Tomato`.
    setupProfileBlockEnv({
      blockedByActor: false,
      blockedByTarget: false,
      actorFollowStatus: 'none',
      targetFollowStatus: 'none',
    });
    mockResolveServerAuthState.mockResolvedValue({
      status: 'authenticated',
      principal: makePrincipal(bob),
      user: {
        public_id: bob.publicId,
        username: bob.username,
        fullName: bob.fullName,
      },
      profile: { handle: bob.handle, avatarUrl: bob.avatarUrl },
      accessTokenRemainingMs: 600_000,
    });
    const allowedMeta = await generateUserProfileMetadata({
      params: Promise.resolve({ handle: 'alice_share' }),
    });
    expect(allowedMeta.title).toBe('@alice_share — Tomato');
  });
});

describe('Security Phần 2: Chặn ghi đè khóa qua PUT backup & Bảo mật Quên mã PIN qua Email OTP', () => {
  const alice = makeUserRow({
    id: '0195c000-0000-7000-8000-000000000001',
    publicId: '11111111-1111-4111-8111-111111111111',
  });

  function setupPinEnv(options: { readonly initialBackup?: UserE2eeKeyBackupRow | null } = {}) {
    let backupRow: UserE2eeKeyBackupRow | null = options.initialBackup ?? null;
    const devices: UserE2eeDeviceRow[] = [];
    const sentEmails: EmailMessage[] = [];
    const auditRecords: { action: string; metadata?: Record<string, unknown> }[] = [];
    const otpStore = new InMemoryPinResetOtpStore();

    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn(async (token?: string) => {
        if (token === 'tok-alice') return makePrincipal(alice);
        const { AuthDomainError } = await import('@/modules/auth/auth.errors');
        throw new AuthDomainError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Vui lòng đăng nhập lại.',
        });
      }),
    } as unknown as SessionService);

    const rateLimiter = {
      consume: vi.fn(async () => ({
        allowed: true,
        limit: 10,
        remaining: 9,
        resetAt: Date.now() + 60_000,
        retryAfterSeconds: 0,
      })),
    };

    const emailProvider: EmailProvider = {
      provider: 'memory',
      send: vi.fn(async (msg: EmailMessage) => {
        sentEmails.push(msg);
      }),
    };

    const auditLogService = {
      record: vi.fn(async (input: { action: string; metadata?: Record<string, unknown> }) => {
        auditRecords.push({ action: input.action, metadata: input.metadata });
        return { id: 'audit-1' };
      }),
    } as unknown as AuditLogService;

    const repository = {
      runInRlsTx: vi.fn(
        async <T>(_userId: string, fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> =>
          fn({} as DatabaseTransaction),
      ),
      findKeyBackupByUserId: vi.fn(async () => backupRow),
      findVerifiedEmailForUser: vi.fn(async () => 'alice.secure@tomato.test'),
      upsertKeyBackup: vi.fn(
        async (params: {
          userId: string;
          encryptedKeyBlob: string;
          kdfSalt: string;
          kdfParams: UserE2eeKeyBackupRow['kdfParams'];
          iv: string;
          keyFingerprint: string;
          version: number;
          now: Date;
        }) => {
          backupRow = {
            userId: params.userId,
            encryptedKeyBlob: params.encryptedKeyBlob,
            kdfSalt: params.kdfSalt,
            kdfParams: params.kdfParams,
            iv: params.iv,
            keyFingerprint: params.keyFingerprint,
            version: params.version,
            updatedAt: params.now,
          };
          return backupRow;
        },
      ),
      upsertUserE2eeDevice: vi.fn(
        async (params: {
          userId: string;
          deviceLabel: string;
          identityPublicKeyJwk: UserE2eeDeviceRow['identityPublicKeyJwk'];
          signingPublicKeyJwk: UserE2eeDeviceRow['signingPublicKeyJwk'];
          keyFingerprint: string;
          isSyncKey?: boolean;
          now: Date;
        }) => {
          if (params.isSyncKey) {
            for (const d of devices) {
              if (d.isSyncKey && d.keyFingerprint !== params.keyFingerprint) {
                (d as { isSyncKey: boolean }).isSyncKey = false;
                (d as { revokedAt: Date | null }).revokedAt = params.now;
              }
            }
          }
          const row: UserE2eeDeviceRow = {
            id: `dev-id-${devices.length + 1}`,
            publicId: `dddddddd-dddd-4ddd-8ddd-${String(devices.length + 1).padStart(12, '0')}`,
            userId: params.userId,
            sessionFamilyId: null,
            deviceLabel: params.deviceLabel,
            identityPublicKeyJwk: params.identityPublicKeyJwk,
            signingPublicKeyJwk: params.signingPublicKeyJwk,
            keyFingerprint: params.keyFingerprint,
            isSyncKey: Boolean(params.isSyncKey),
            revokedAt: null,
            lastSeenAt: params.now,
            createdAt: params.now,
          };
          devices.push(row);
          return { device: row, revokedDevicePublicIds: [] };
        },
      ),
      markDeviceAsSyncKeyByFingerprint: vi.fn(async () => null),
    } as unknown as ChatRepository;

    setChatServiceForTesting(
      new ChatService({
        repository,
        rateLimiter,
        realtimeProvider: new InMemoryRealtimeAdapter(),
        pinResetOtpStore: otpStore,
        emailProvider,
        auditLogService,
      }),
    );

    return {
      getBackup: () => backupRow,
      devices,
      sentEmails,
      auditRecords,
      rateLimiter,
      otpStore,
    };
  }

  it('proxy.ts gắn Cache-Control: no-store cho /api/v1/e2ee/backup/reset/*', () => {
    const origin = getTestOrigin();
    for (const path of ['/api/v1/e2ee/backup/reset/request', '/api/v1/e2ee/backup/reset/confirm']) {
      const req = new NextRequest(`${origin}${path}`, { method: 'POST' });
      const res = proxy(req);
      expect(res.headers.get('cache-control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    }
  });

  it('bắt buộc Access Token (401) và CSRF 3 lớp (403) trên cả 2 endpoint reset/request và reset/confirm', async () => {
    const origin = getTestOrigin();
    setupPinEnv();

    // Thiếu CSRF -> 403
    const noCsrfReq = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', false),
        body: '{}',
      }),
    );
    expect(noCsrfReq.status).toBe(403);

    const noCsrfConfirm = await pinResetConfirmPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', false),
        body: '{}',
      }),
    );
    expect(noCsrfConfirm.status).toBe(403);

    // Thiếu Access Token -> 401
    const unauthReq = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: {
          origin,
          'sec-fetch-site': 'same-origin',
          cookie: `tomato_csrf=${TEST_CSRF}`,
          [CSRF_HEADER_NAME]: TEST_CSRF,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(unauthReq.status).toBe(401);
  });

  it('chặn Quên PIN khi tài khoản chưa từng tạo mã PIN (409, không gửi email) và chặn field lạ (.strict())', async () => {
    const origin = getTestOrigin();
    const env = setupPinEnv({ initialBackup: null });

    // Tài khoản chưa tạo mã PIN -> 409 CONFLICT, 0 email được gửi.
    const noBackupRes = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: '{}',
      }),
    );
    expect(noBackupRes.status).toBe(409);
    expect(env.sentEmails).toHaveLength(0);

    // Truyền thêm field `email` lạ trong body -> 400 VALIDATION_ERROR (Zod .strict()).
    const extraFieldRes = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({ email: 'attacker@evil.com' }),
      }),
    );
    expect(extraFieldRes.status).toBe(400);
    expect(env.sentEmails).toHaveLength(0);
  });

  it('PUT /api/v1/e2ee/backup cho phép Đổi PIN (cùng keyFingerprint, tăng version) nhưng CHẶN ghi đè sang khóa khác (409)', async () => {
    const origin = getTestOrigin();
    setupPinEnv();

    const initial = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '112233',
      persistLocally: false,
    });

    // Tạo lần đầu -> version 1
    const createRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({
          ...initial.backup,
          ...initial.publicRegistration,
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const createdBody = (await createRes.json()) as { backup: { version: number } };
    expect(createdBody.backup.version).toBe(1);

    // Đổi PIN hợp lệ (cùng keyFingerprint) -> version 2
    const changed = await reEncryptPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      currentPin: '112233',
      newPin: '445566',
      backup: initial.backup,
      persistLocally: false,
    });
    const changeRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({
          ...changed.backup,
          ...changed.publicRegistration,
        }),
      }),
    );
    expect(changeRes.status).toBe(200);
    const changedBody = (await changeRes.json()) as { backup: { version: number } };
    expect(changedBody.backup.version).toBe(2);

    // Cố gắng tạo cặp khóa hoàn toàn mới ghi đè qua PUT mà không qua Quên PIN Email OTP -> 409 CONFLICT!
    const rogue = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '778899',
      persistLocally: false,
    });
    const rogueRes = await e2eeBackupPut(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        method: 'PUT',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({
          ...rogue.backup,
          ...rogue.publicRegistration,
        }),
      }),
    );
    expect(rogueRes.status).toBe(409);

    // Xác minh GET vẫn giữ bản sao lưu hợp lệ version 2.
    const getRes = await e2eeBackupGet(
      new Request(`${origin}/api/v1/e2ee/backup`, {
        headers: createAuthHeaders(origin, 'tok-alice', false),
      }),
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      backup: { version: number; keyFingerprint: string };
    };
    expect(getBody.backup.version).toBe(2);
    expect(getBody.backup.keyFingerprint).toBe(initial.backup.keyFingerprint);
  });

  it('Quên mã PIN trọn luồng bảo mật: sai 5 lần tự hủy OTP, iterations yếu bị chặn, đúng OTP tăng version & chặn replay song song', async () => {
    const origin = getTestOrigin();
    const initial = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '123456',
      persistLocally: false,
    });

    const env = setupPinEnv({
      initialBackup: {
        userId: alice.id,
        encryptedKeyBlob: initial.backup.encryptedKeyBlob,
        kdfSalt: initial.backup.kdfSalt,
        kdfParams: initial.backup.kdfParams,
        iv: initial.backup.iv,
        keyFingerprint: initial.backup.keyFingerprint,
        version: 1,
        updatedAt: new Date(),
      },
    });

    // 1. Yêu cầu OTP -> trả email đã che, không lộ OTP trong response hay audit log.
    const reqRes1 = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: '{}',
      }),
    );
    expect(reqRes1.status).toBe(200);
    expect(reqRes1.headers.get('cache-control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const reqBody1 = (await reqRes1.json()) as { maskedEmail: string; resendAfterSeconds: number };
    expect(reqBody1.maskedEmail).toBe('a***@tomato.test');
    expect(reqBody1.resendAfterSeconds).toBe(60);
    expect(env.sentEmails).toHaveLength(1);
    const realOtp1 = extractSixDigitOtpFromEmail(env.sentEmails[0]!);
    expect(JSON.stringify(reqBody1)).not.toContain(realOtp1);
    expect(JSON.stringify(env.auditRecords)).not.toContain(realOtp1);

    const newKeypack = await createPinProtectedKeyBackup({
      userPublicId: alice.publicId,
      pin: '987654',
      persistLocally: false,
    });

    // 2. Từ chối iterations < 600.000.
    const weakIterRes = await pinResetConfirmPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({
          otpCode: realOtp1,
          encryptedKeyBlob: newKeypack.backup.encryptedKeyBlob,
          kdfSalt: newKeypack.backup.kdfSalt,
          kdfParams: { alg: 'PBKDF2-SHA256', iterations: 100_000 },
          iv: newKeypack.backup.iv,
          keyFingerprint: newKeypack.backup.keyFingerprint,
          identityPublicKeyJwk: newKeypack.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: newKeypack.publicRegistration.signingPublicKeyJwk,
          deviceLabel: newKeypack.publicRegistration.deviceLabel,
        }),
      }),
    );
    expect(weakIterRes.status).toBe(400);

    // 3. Nhập sai OTP 5 lần -> tự hủy OTP (lần thứ 6 nhập đúng OTP cũ cũng phải bị từ chối).
    const wrongOtp = realOtp1 === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const badRes = await pinResetConfirmPost(
        new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-alice'),
          body: JSON.stringify({
            otpCode: wrongOtp,
            encryptedKeyBlob: newKeypack.backup.encryptedKeyBlob,
            kdfSalt: newKeypack.backup.kdfSalt,
            kdfParams: newKeypack.backup.kdfParams,
            iv: newKeypack.backup.iv,
            keyFingerprint: newKeypack.backup.keyFingerprint,
            identityPublicKeyJwk: newKeypack.publicRegistration.identityPublicKeyJwk,
            signingPublicKeyJwk: newKeypack.publicRegistration.signingPublicKeyJwk,
            deviceLabel: newKeypack.publicRegistration.deviceLabel,
          }),
        }),
      );
      expect(badRes.status).toBe(400);
    }

    const afterDestroyedRes = await pinResetConfirmPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: JSON.stringify({
          otpCode: realOtp1,
          encryptedKeyBlob: newKeypack.backup.encryptedKeyBlob,
          kdfSalt: newKeypack.backup.kdfSalt,
          kdfParams: newKeypack.backup.kdfParams,
          iv: newKeypack.backup.iv,
          keyFingerprint: newKeypack.backup.keyFingerprint,
          identityPublicKeyJwk: newKeypack.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: newKeypack.publicRegistration.signingPublicKeyJwk,
          deviceLabel: newKeypack.publicRegistration.deviceLabel,
        }),
      }),
    );
    expect(afterDestroyedRes.status).toBe(400);

    // 4. Xin mã OTP mới & thử gửi 2 request confirm song song (replay race) -> chỉ 1 thành công, 1 bị từ chối!
    const reqRes2 = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: '{}',
      }),
    );
    expect(reqRes2.status).toBe(200);
    const realOtp2 = extractSixDigitOtpFromEmail(env.sentEmails[1]!);

    const confirmPayload = JSON.stringify({
      otpCode: realOtp2,
      encryptedKeyBlob: newKeypack.backup.encryptedKeyBlob,
      kdfSalt: newKeypack.backup.kdfSalt,
      kdfParams: newKeypack.backup.kdfParams,
      iv: newKeypack.backup.iv,
      keyFingerprint: newKeypack.backup.keyFingerprint,
      identityPublicKeyJwk: newKeypack.publicRegistration.identityPublicKeyJwk,
      signingPublicKeyJwk: newKeypack.publicRegistration.signingPublicKeyJwk,
      deviceLabel: newKeypack.publicRegistration.deviceLabel,
    });

    const [resA, resB] = await Promise.all([
      pinResetConfirmPost(
        new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-alice'),
          body: confirmPayload,
        }),
      ),
      pinResetConfirmPost(
        new Request(`${origin}/api/v1/e2ee/backup/reset/confirm`, {
          method: 'POST',
          headers: createAuthHeaders(origin, 'tok-alice'),
          body: confirmPayload,
        }),
      ),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 400]);

    expect(env.getBackup()?.version).toBe(2);
    expect(env.getBackup()?.keyFingerprint).toBe(newKeypack.backup.keyFingerprint);
    expect(
      env.devices.some((d) => d.isSyncKey && d.keyFingerprint === newKeypack.backup.keyFingerprint),
    ).toBe(true);
    expect(env.auditRecords.some((r) => r.action === 'E2EE_PIN_RESET_COMPLETED')).toBe(true);
    expect(JSON.stringify(env.auditRecords)).not.toContain(realOtp2);
    expect(JSON.stringify(env.auditRecords)).not.toContain('987654');

    // 5. Rate limit trả 429 rõ ràng.
    env.rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
    });
    const limitedRes = await pinResetRequestPost(
      new Request(`${origin}/api/v1/e2ee/backup/reset/request`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice'),
        body: '{}',
      }),
    );
    expect(limitedRes.status).toBe(429);
  });
});
