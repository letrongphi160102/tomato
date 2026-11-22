import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import type { SessionRow, UserRow } from '@/core/db/schema';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';
import { getCsrfTokenFromDocumentCookie, sanitizeRedirectPath } from '@/lib/auth-client';
import {
  AuthDomainError,
  UNKNOWN_DEVICE_LABEL,
  assertCanAccessUserSessions,
  assertCanChangeOwnPassword,
  assertCanRevokeSession,
  assertCanRevokeUserSessions,
  canAccessUserSessions,
  canChangeOwnPassword,
  canRevokeSession,
  loginInputSchema,
  parseDeviceInfo,
  revokeAllSessionsInputSchema,
  type AuthenticatedPrincipal,
} from '@/modules/auth';
import { proxy } from '@/proxy';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: '01950000-0000-7000-8000-000000000001',
    publicId: 'user-public-1',
    username: 'user_a',
    fullName: 'User A',
    gender: 'other',
    dateOfBirth: '1999-01-01',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: '01950000-0000-7000-8000-000000000010',
    publicId: 'session-public-1',
    userId: '01950000-0000-7000-8000-000000000001',
    familyId: 'family-1',
    refreshTokenHash: 'a'.repeat(64),
    deviceInfo: 'Chrome 130 / Windows 10/11',
    ipAddress: '198.51.100.1',
    lastUsedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-31T00:00:00Z'),
    revokedAt: null,
    revokeReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('Unit M3: Device Info Parser, Auth Policy (Deny-by-default), Login Schemas & Proxy Guard', () => {
  it('parseDeviceInfo phân tích đúng trình duyệt & hệ điều hành phổ biến, an toàn trước UA quá dài/ký tự lạ', () => {
    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 130 / Windows 10/11');

    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51',
      ),
    ).toBe('Edge 131 / Windows 10/11');

    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      ),
    ).toBe('Safari 18 / macOS');

    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari 18 / iOS');

    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome 129 / Android 14');

    expect(
      parseDeviceInfo(
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      ),
    ).toBe('Firefox 132 / Linux');

    expect(parseDeviceInfo(null)).toBe(UNKNOWN_DEVICE_LABEL);
    expect(parseDeviceInfo('   \r\n\t  ')).toBe(UNKNOWN_DEVICE_LABEL);

    // Chống ReDoS / chuỗi cực dài.
    const hostileUa = 'A'.repeat(20_000);
    const parsedHostile = parseDeviceInfo(hostileUa);
    expect(parsedHostile).toBe(UNKNOWN_DEVICE_LABEL);
    expect(parsedHostile.length).toBeLessThanOrEqual(255);
  });

  it('auth.policy.ts áp dụng Deny by default và trả 404 NOT_FOUND khi User A truy cập phiên User B hoặc phiên không tồn tại', () => {
    const userA = makeUser();
    const sessionA = makeSession({ userId: userA.id });
    const principalA: AuthenticatedPrincipal = { user: userA, session: sessionA };

    const sessionB = makeSession({
      id: '01950000-0000-7000-8000-000000000020',
      publicId: 'session-public-b',
      userId: '01950000-0000-7000-8000-000000000002',
    });

    // Chính chủ active -> được phép.
    expect(canAccessUserSessions(principalA, userA.id)).toBe(true);
    expect(canRevokeSession(principalA, sessionA)).toBe(true);
    expect(() => assertCanRevokeSession(principalA, sessionA)).not.toThrow();
    expect(() => assertCanAccessUserSessions(principalA, userA.id)).not.toThrow();
    expect(() => assertCanRevokeUserSessions(principalA, userA.id)).not.toThrow();

    // Khác chủ (IDOR) -> từ chối, assertCanRevokeSession ném 404 NOT_FOUND.
    expect(canRevokeSession(principalA, sessionB)).toBe(false);
    expect(canAccessUserSessions(principalA, sessionB.userId)).toBe(false);

    for (const deniedTarget of [sessionB, null, undefined]) {
      try {
        assertCanRevokeSession(principalA, deniedTarget);
        expect.unreachable('Phải ném AuthDomainError 404');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthDomainError);
        expect((err as AuthDomainError).status).toBe(404);
        expect((err as AuthDomainError).code).toBe('NOT_FOUND');
      }
    }

    // Principal không hợp lệ / bị thu hồi / bị khóa -> Deny by default.
    const lockedPrincipal: AuthenticatedPrincipal = {
      user: makeUser({ status: 'locked' }),
      session: sessionA,
    };
    const revokedPrincipal: AuthenticatedPrincipal = {
      user: userA,
      session: makeSession({ revokedAt: new Date() }),
    };

    expect(canRevokeSession(null, sessionA)).toBe(false);
    expect(canRevokeSession(lockedPrincipal, sessionA)).toBe(false);
    expect(canRevokeSession(revokedPrincipal, sessionA)).toBe(false);
  });

  it('loginInputSchema chuẩn hóa email + NFKC mật khẩu (không trim) và revokeAllSessionsInputSchema mặc định includeCurrent=false', () => {
    const parsed = loginInputSchema.parse({
      email: '  USER@Example.COM  ',
      password: '  short pass  ',
    });
    expect(parsed.email).toBe('user@example.com');
    // Không trim khoảng trắng ở mật khẩu và không chặn < 12 ký tự ở form login.
    expect(parsed.password).toBe('  short pass  ');

    const tooLong = loginInputSchema.safeParse({
      email: 'user@example.com',
      password: 'a'.repeat(129),
    });
    expect(tooLong.success).toBe(false);

    expect(revokeAllSessionsInputSchema.parse({})).toEqual({ includeCurrent: false });
    expect(revokeAllSessionsInputSchema.parse({ includeCurrent: true })).toEqual({
      includeCurrent: true,
    });
  });

  it('sanitizeRedirectPath chặn Open Redirect và getCsrfTokenFromDocumentCookie ưu tiên __Host-tomato_csrf', () => {
    expect(sanitizeRedirectPath('/settings/security')).toBe('/settings/security');
    expect(sanitizeRedirectPath('/settings/security?tab=devices')).toBe(
      '/settings/security?tab=devices',
    );
    expect(sanitizeRedirectPath('https://evil.invalid/phish')).toBe('/settings/security');
    expect(sanitizeRedirectPath('//evil.invalid/phish')).toBe('/settings/security');
    expect(sanitizeRedirectPath('/\\evil.invalid')).toBe('/settings/security');
    expect(sanitizeRedirectPath('javascript:alert(1)')).toBe('/settings/security');
    expect(sanitizeRedirectPath('')).toBe('/settings/security');

    expect(
      getCsrfTokenFromDocumentCookie('tomato_csrf=local-token; __Host-tomato_csrf=prod-token'),
    ).toBe('prod-token');
    expect(getCsrfTokenFromDocumentCookie('other=1; tomato_csrf=local-token')).toBe('local-token');
    expect(getCsrfTokenFromDocumentCookie('')).toBeNull();
  });

  it('proxy() bảo vệ /settings/*: redirect 307 về /login khi thiếu cả AT và RT, cho qua khi có AT hoặc RT kèm Cache-Control: no-store', () => {
    const unauthReq = new NextRequest('http://localhost:3000/settings/security?view=all');
    const unauthRes = proxy(unauthReq);
    expect(unauthRes.status).toBe(307);
    expect(unauthRes.headers.get('location')).toBe(
      'http://localhost:3000/login?next=%2Fsettings%2Fsecurity%3Fview%3Dall',
    );
    expect(unauthRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(unauthRes.headers.get('X-Frame-Options')).toBe('DENY');

    // Khi AT hết hạn nhưng vẫn còn cookie RT -> cho qua để client tự động gọi `/refresh`.
    const refreshOnlyReq = new NextRequest('http://localhost:3000/settings/security', {
      headers: {
        cookie: 'tomato_rt=synthetic-refresh-token-value',
      },
    });
    const refreshOnlyRes = proxy(refreshOnlyReq);
    expect(refreshOnlyRes.status).toBe(200);
    expect(refreshOnlyRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
  });

  it('auth.policy.ts áp dụng Deny by default cho quyền đổi mật khẩu (canChangeOwnPassword)', () => {
    const activeUser = makeUser({ status: 'active' });
    const activeSession = makeSession({ userId: activeUser.id, revokedAt: null });
    const validPrincipal: AuthenticatedPrincipal = { user: activeUser, session: activeSession };

    expect(canChangeOwnPassword(validPrincipal)).toBe(true);
    expect(() => assertCanChangeOwnPassword(validPrincipal)).not.toThrow();

    const revokedPrincipal: AuthenticatedPrincipal = {
      user: activeUser,
      session: makeSession({ userId: activeUser.id, revokedAt: new Date() }),
    };
    expect(canChangeOwnPassword(revokedPrincipal)).toBe(false);
    expect(() => assertCanChangeOwnPassword(revokedPrincipal)).toThrow(AuthDomainError);

    const lockedPrincipal: AuthenticatedPrincipal = {
      user: makeUser({ status: 'locked' }),
      session: activeSession,
    };
    expect(canChangeOwnPassword(lockedPrincipal)).toBe(false);
    expect(canChangeOwnPassword(null)).toBe(false);
  });
});
