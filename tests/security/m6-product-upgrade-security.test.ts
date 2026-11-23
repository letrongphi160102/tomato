import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { metadata as loginPageMetadata } from '@/app/(auth)/login/page';
import { metadata as devicesPageMetadata } from '@/app/(dashboard)/settings/devices/page';
import { POST as changePasswordPost } from '@/app/api/v1/auth/change-password/route';
import { POST as verifyOtpPost } from '@/app/api/v1/auth/change-password/verify-otp/route';
import { metadata as rootMetadata } from '@/app/layout';
import { AuthenticatedHome } from '@/components/home/authenticated-home';
import { LandingHero } from '@/components/home/landing-hero';
import { AccountOverviewCard } from '@/components/settings/account-overview-card';
import { getEnv, resetEnvCacheForTesting } from '@/core/config/env';
import { hashPassword } from '@/core/crypto/password';
import { generateSecureToken, hashScopedTokenSha256 } from '@/core/crypto/token';
import type { SessionRow, UserRow, VerificationTokenRow } from '@/core/db/schema';
import type { RateLimiter } from '@/core/redis/rate-limiter';
import type { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import {
  AuthService,
  PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
  type AuthRepository,
  type AuthenticatedPrincipal,
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

function makePrincipal(overrides?: {
  readonly userId?: string;
  readonly familyId?: string;
  readonly sessionPublicId?: string;
}): AuthenticatedPrincipal {
  const userId = overrides?.userId ?? '01950000-0000-7000-8000-000000006001';
  const user: UserRow = {
    id: userId,
    publicId: '8a6f2d8b-c71b-4239-898a-b88f9f03c601',
    username: 'm6_sec_user',
    fullName: 'Tran Bao An',
    gender: 'female',
    dateOfBirth: '1999-05-05',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };
  const session: SessionRow = {
    id: '01950000-0000-7000-8000-000000006010',
    publicId: overrides?.sessionPublicId ?? 'session-public-m6-1',
    userId,
    familyId: overrides?.familyId ?? 'family-m6-device-a',
    refreshTokenHash: 'b'.repeat(64),
    deviceInfo: 'Chrome 130 / Windows 10/11',
    ipAddress: '203.0.113.10',
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokeReason: null,
    createdAt: new Date(),
  };
  return { user, session };
}

describe('Security M6: Server-Enforced 2-Step Password Change, Ticket Family Binding & Clean Production UI', () => {
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

  it('chặn tuyệt đối nhảy cóc Bước 1: gọi POST /change-password không có ticket cookie trả 403, xóa cookie ticket và không chạm DB/Argon2id', async () => {
    const principal = makePrincipal();
    const csrfToken = generateSecureToken(32);
    const findIdentitySpy = vi.fn();

    setAuthServiceForTesting(
      new AuthService({
        rateLimiter: makeAllowRateLimiter(),
        repository: {
          findEmailIdentityByUserId: findIdentitySpy,
        } as unknown as AuthRepository,
        emailProvider: { provider: 'memory', send: vi.fn() },
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
        appUrl: allowedOrigin,
      }),
    );
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(principal),
    } as unknown as SessionService);

    const res = await changePasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify({
          currentPassword: 'old safe passphrase 2026!',
          newPassword: 'new safe passphrase 2027!',
        }),
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOKEN_INVALID');
    expect(findIdentitySpy).not.toHaveBeenCalled();
    expect(
      res.headers
        .getSetCookie()
        .some((c) => c.startsWith('tomato_pwd_ticket=') && c.includes('Max-Age=0')),
    ).toBe(true);
  });

  it('ticket Bước 1 gắn chặt với (userId, session.familyId): đánh cắp ticket sang thiết bị B bị chặn 403', async () => {
    const deviceAPrincipal = makePrincipal({ familyId: 'family-device-a' });
    const deviceBPrincipal = makePrincipal({
      familyId: 'family-device-b',
      sessionPublicId: 'session-public-m6-b',
    });

    const rawTicket = generateSecureToken(32);
    const hashForDeviceA = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: deviceAPrincipal.user.id,
      sessionFamilyId: deviceAPrincipal.session.familyId,
    });
    const storedRow: VerificationTokenRow = {
      id: '01950000-0000-7000-8000-000000006099',
      userId: deviceAPrincipal.user.id,
      purpose: 'password_change_ticket',
      tokenHash: hashForDeviceA,
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      consumedAt: null,
      createdAt: new Date(),
    };

    const hashedPw = await hashPassword('current strong passphrase 2026!');
    const csrfToken = generateSecureToken(32);

    setAuthServiceForTesting(
      new AuthService({
        rateLimiter: makeAllowRateLimiter(),
        repository: {
          findEmailIdentityByUserId: vi.fn().mockResolvedValue({
            id: '01950000-0000-7000-8000-000000006002',
            userId: deviceAPrincipal.user.id,
            provider: 'email_password',
            identifierNormalized: 'cross-device@tomato.test',
            passwordHash: hashedPw.hash,
            pepperVersion: hashedPw.pepperVersion,
            verifiedAt: new Date(),
            failedLoginAttempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          // Tra cứu theo đúng `(userId, purpose, tokenHash)`: chỉ tìm thấy khi hash khớp family-device-a.
          findVerificationTokenByHashForUser: vi.fn(
            async (userId: string, _purpose: string, tokenHash: string) =>
              userId === storedRow.userId && tokenHash === storedRow.tokenHash ? storedRow : null,
          ),
        } as unknown as AuthRepository,
        emailProvider: { provider: 'memory', send: vi.fn() },
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
        appUrl: allowedOrigin,
      }),
    );
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(deviceBPrincipal),
    } as unknown as SessionService);

    const res = await changePasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${csrfToken}; tomato_pwd_ticket=${rawTicket}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify({
          currentPassword: 'current strong passphrase 2026!',
          newPassword: 'stolen attempt passphrase 2027!',
        }),
      }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TOKEN_INVALID');
  });

  it('nhập sai currentPassword tới lần thứ 5 trong Bước 2 tự hủy ticket, trả 403 và xóa cookie tomato_pwd_ticket', async () => {
    const principal = makePrincipal();
    const rawTicket = generateSecureToken(32);
    const ticketHash = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: principal.user.id,
      sessionFamilyId: principal.session.familyId,
    });
    const hashedPw = await hashPassword('actual strong passphrase 2026!');
    const csrfToken = generateSecureToken(32);

    let attemptCount = PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS - 1;
    let consumedAt: Date | null = null;

    setAuthServiceForTesting(
      new AuthService({
        rateLimiter: makeAllowRateLimiter(),
        repository: {
          getDb: () => ({
            transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
          }),
          findEmailIdentityByUserId: vi.fn().mockResolvedValue({
            id: '01950000-0000-7000-8000-000000006002',
            userId: principal.user.id,
            provider: 'email_password',
            identifierNormalized: 'exhaust@tomato.test',
            passwordHash: hashedPw.hash,
            pepperVersion: hashedPw.pepperVersion,
            verifiedAt: new Date(),
            failedLoginAttempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          lockUserById: vi.fn().mockResolvedValue(principal.user),
          findSessionByPublicIdForUser: vi.fn().mockResolvedValue(principal.session),
          findVerificationTokenByHashForUser: vi.fn(async () => ({
            id: '01950000-0000-7000-8000-000000006088',
            userId: principal.user.id,
            purpose: 'password_change_ticket' as const,
            tokenHash: ticketHash,
            attemptCount,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            consumedAt,
            createdAt: new Date(),
          })),
          lockVerificationTokenByHashForUser: vi.fn(async () => ({
            id: '01950000-0000-7000-8000-000000006088',
            userId: principal.user.id,
            purpose: 'password_change_ticket' as const,
            tokenHash: ticketHash,
            attemptCount,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            consumedAt,
            createdAt: new Date(),
          })),
          updateVerificationTokenAttempt: vi.fn(
            async (_id: string, _uid: string, nextAttempts: number, nextConsumed: Date | null) => {
              attemptCount = nextAttempts;
              consumedAt = nextConsumed;
            },
          ),
        } as unknown as AuthRepository,
        emailProvider: { provider: 'memory', send: vi.fn() },
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
        appUrl: allowedOrigin,
      }),
    );
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(principal),
    } as unknown as SessionService);

    const fifthWrongRes = await changePasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${csrfToken}; tomato_pwd_ticket=${rawTicket}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify({
          currentPassword: 'wrong current passphrase 2026!',
          newPassword: 'brand new safe passphrase 2027!',
        }),
      }),
    );

    expect(fifthWrongRes.status).toBe(403);
    expect(attemptCount).toBe(PASSWORD_CHANGE_TICKET_MAX_ATTEMPTS);
    expect(consumedAt).not.toBeNull();
    expect(
      fifthWrongRes.headers
        .getSetCookie()
        .some((c) => c.startsWith('tomato_pwd_ticket=') && c.includes('Max-Age=0')),
    ).toBe(true);

    // Audit Q3: nếu phiên hiện tại đã bị thu hồi song song trong lúc Argon2id chạy -> trả 401 và KHÔNG sửa attemptCount của ticket.
    const updateAttemptSpy = vi.fn();
    setAuthServiceForTesting(
      new AuthService({
        rateLimiter: makeAllowRateLimiter(),
        repository: {
          getDb: () => ({
            transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
          }),
          findEmailIdentityByUserId: vi.fn().mockResolvedValue({
            id: '01950000-0000-7000-8000-000000006002',
            userId: principal.user.id,
            provider: 'email_password',
            identifierNormalized: 'revoked-mid@tomato.test',
            passwordHash: hashedPw.hash,
            pepperVersion: hashedPw.pepperVersion,
            verifiedAt: new Date(),
            failedLoginAttempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          lockUserById: vi.fn().mockResolvedValue(principal.user),
          findSessionByPublicIdForUser: vi.fn().mockResolvedValue({
            ...principal.session,
            revokedAt: new Date(),
            revokeReason: 'user_logout',
          }),
          findVerificationTokenByHashForUser: vi.fn().mockResolvedValue({
            id: '01950000-0000-7000-8000-000000006088',
            userId: principal.user.id,
            purpose: 'password_change_ticket' as const,
            tokenHash: ticketHash,
            attemptCount: 0,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            consumedAt: null,
            createdAt: new Date(),
          }),
          updateVerificationTokenAttempt: updateAttemptSpy,
        } as unknown as AuthRepository,
        emailProvider: { provider: 'memory', send: vi.fn() },
        auditLogService: { record: vi.fn() } as unknown as AuditLogService,
        appUrl: allowedOrigin,
      }),
    );

    const revokedMidRes = await changePasswordPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${csrfToken}; tomato_pwd_ticket=${rawTicket}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify({
          currentPassword: 'wrong current passphrase 2026!',
          newPassword: 'brand new safe passphrase 2027!',
        }),
      }),
    );
    expect(revokedMidRes.status).toBe(401);
    expect(updateAttemptSpy).not.toHaveBeenCalled();
  });

  it('POST /change-password/verify-otp không bao giờ trả raw ticket ra JSON body và gắn HttpOnly cookie đúng chuẩn', async () => {
    const principal = makePrincipal();
    const csrfToken = generateSecureToken(32);
    const issuedTicket = generateSecureToken(32);

    setAuthServiceForTesting({
      verifyPasswordChangeOtp: vi.fn().mockResolvedValue({
        verified: true,
        expiresInMinutes: 10,
        message: 'Xác nhận email thành công.',
        ticket: issuedTicket,
      }),
    } as unknown as AuthService);
    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn().mockResolvedValue(principal),
    } as unknown as SessionService);

    const res = await verifyOtpPost(
      new Request(`${allowedOrigin}/api/v1/auth/change-password/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          'Sec-Fetch-Site': 'same-origin',
          cookie: `tomato_at=synthetic-at; tomato_csrf=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify({ otpCode: '123456' }),
      }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(issuedTicket);
    expect(text).not.toContain('"ticket"');

    const ticketCookie = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('tomato_pwd_ticket='));
    expect(ticketCookie).toBeDefined();
    expect(ticketCookie).toContain('HttpOnly');
    expect(ticketCookie).toContain('Max-Age=600');
  });

  it('LandingHero dùng logo transparent PNG Tomato, đúng slogan "Kết nối và khám phá cùng nhau", favicon & metadata đúng chuẩn và ẩn /api/health ở Production', () => {
    const prodHtml = renderToStaticMarkup(
      React.createElement(LandingHero, { showDevHealthLink: false }),
    );
    expect(prodHtml).toContain('Tomato');
    expect(prodHtml).toContain('/images/brand/tomato-logo.png');
    expect(prodHtml).toContain('Kết nối và khám phá cùng nhau');
    expect(prodHtml).not.toContain('/api/health');
    expect(prodHtml).not.toContain('Giai đoạn 1');
    expect(prodHtml).not.toContain('Modular Monolith');
    expect(prodHtml).not.toContain('Argon2id');

    const devHtml = renderToStaticMarkup(
      React.createElement(LandingHero, { showDevHealthLink: true }),
    );
    expect(devHtml).toContain('/api/health');

    // Tiêu đề tab trang chủ và các trang khác đổi TOMATO -> Tomato, tồn tại icon & logo transparent.
    expect(rootMetadata.title).toBe('Tomato - Kết nối và khám phá cùng nhau');
    expect(loginPageMetadata.title).toBe('Đăng nhập — Tomato');
    expect(devicesPageMetadata.title).toBe('Thiết bị đăng nhập — Tomato');
    expect(existsSync(join(process.cwd(), 'src/app/icon.png'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'public/images/brand/tomato-logo.png'))).toBe(true);

    // Giao diện đổi mật khẩu không còn thanh 2 tab Bước 1/Bước 2 hay nút "Quay lại Bước 1".
    const changePasswordSource = readFileSync(
      join(process.cwd(), 'src/components/settings/change-password-card.tsx'),
      'utf8',
    );
    expect(changePasswordSource).not.toContain('Bước 1:');
    expect(changePasswordSource).not.toContain('Bước 2:');
    expect(changePasswordSource).not.toContain('Quay lại Bước 1');
  });

  it('AuthenticatedHome và AccountOverviewCard render sạch trên Server (không lộ "(active)", không gọi hàm tiện ích từ file "use client")', () => {
    const sampleUser = {
      public_id: '8a6f2d8b-c71b-4239-898a-b88f9f03c601',
      username: 'minh_anh',
      fullName: 'Nguyễn Minh Anh',
      gender: 'female' as const,
      status: 'active' as const,
    };

    const homeHtml = renderToStaticMarkup(
      React.createElement(AuthenticatedHome, { user: sampleUser }),
    );
    expect(homeHtml).toContain('Nguyễn Minh Anh');
    expect(homeHtml).toContain('NA');
    expect(homeHtml).toContain('Kết nối và khám phá cùng nhau');

    const accountHtml = renderToStaticMarkup(
      React.createElement(AccountOverviewCard, { user: sampleUser }),
    );
    expect(accountHtml).toContain('Đang hoạt động');
    expect(accountHtml).not.toContain('(active)');
    expect(accountHtml).toContain('Nữ');

    // Chống tái phát React #441: không file `'use client'` nào được export hàm helper thường (chữ đầu viết thường).
    const walkTsFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkTsFiles(full));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          results.push(full);
        }
      }
      return results;
    };

    const clientHelperExports: string[] = [];
    for (const filePath of walkTsFiles(join(process.cwd(), 'src'))) {
      const content = readFileSync(filePath, 'utf8');
      if (!/^['"]use client['"];?/m.test(content.trimStart())) {
        continue;
      }
      const matches = content.matchAll(/^export\s+(?:async\s+)?function\s+([a-z][A-Za-z0-9_]*)/gm);
      for (const match of matches) {
        clientHelperExports.push(`${filePath}:${match[1]}`);
      }
    }
    expect(clientHelperExports).toEqual([]);
  });
});
