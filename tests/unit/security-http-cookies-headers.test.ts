import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { clearAuthCookies, getCookieNames, setAuthCookies } from '@/core/security/cookies';
import {
  HSTS_HEADER_VALUE,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  generateCspNonce,
} from '@/core/security/headers';
import {
  AUTH_CACHE_CONTROL_HEADER,
  createAuthJsonResponse,
  createErrorResponse,
  formatZodErrorDetails,
} from '@/core/security/http-response';
import { proxy } from '@/proxy';

describe('Security Headers, Cookies & HTTP Error Response', () => {
  it('CSP production dùng nonce chặt chẽ, không có unsafe-eval, bật HSTS khi HTTPS và tắt khi HTTP local', () => {
    const nonce = generateCspNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(20);

    const prodHttpsHeaders = buildSecurityHeaders({
      nonce,
      isProduction: true,
      isHttps: true,
      isApiRoute: false,
      isAuthApiRoute: false,
    });

    expect(prodHttpsHeaders['Content-Security-Policy']).toContain(`'nonce-${nonce}'`);
    expect(prodHttpsHeaders['Content-Security-Policy']).not.toContain("'unsafe-eval'");
    expect(prodHttpsHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(prodHttpsHeaders['Content-Security-Policy']).toContain('upgrade-insecure-requests');
    expect(prodHttpsHeaders['Strict-Transport-Security']).toBe(HSTS_HEADER_VALUE);
    expect(prodHttpsHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(prodHttpsHeaders['X-Frame-Options']).toBe('DENY');
    expect(prodHttpsHeaders['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(prodHttpsHeaders['Permissions-Policy']).toContain('camera=()');

    const devHttpHeaders = buildSecurityHeaders({
      nonce,
      isProduction: false,
      isHttps: false,
      isApiRoute: false,
      isAuthApiRoute: false,
    });

    expect(devHttpHeaders['Strict-Transport-Security']).toBeUndefined();
    expect(devHttpHeaders['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');

    // API Auth route luôn có Cache-Control: no-store, max-age=0 và CSP khóa chặt default-src 'none'.
    const authApiHeaders = buildSecurityHeaders({
      nonce,
      isProduction: true,
      isHttps: true,
      isApiRoute: true,
      isAuthApiRoute: true,
    });
    expect(authApiHeaders['Cache-Control']).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(authApiHeaders['Content-Security-Policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('proxy() gắn Security Headers + x-nonce cho trang và gắn Cache-Control: no-store cho /api/v1/auth/*', () => {
    const pageReq = new NextRequest('http://localhost:3000/login');
    const pageRes = proxy(pageReq);

    expect(pageRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(pageRes.headers.get('X-Frame-Options')).toBe('DENY');
    expect(pageRes.headers.get('Content-Security-Policy')).toContain("'nonce-");

    const authApiReq = new NextRequest('http://localhost:3000/api/v1/auth/me');
    const authApiRes = proxy(authApiReq);
    expect(authApiRes.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
  });

  it('Cookie helper dùng prefix __Host- ở production và bỏ prefix ở dev/test, gắn HttpOnly/SameSite/Secure đúng chuẩn', () => {
    expect(getCookieNames(true)).toEqual({
      accessToken: '__Host-tomato_at',
      refreshToken: '__Host-tomato_rt',
      csrfToken: '__Host-tomato_csrf',
    });

    expect(getCookieNames(false)).toEqual({
      accessToken: 'tomato_at',
      refreshToken: 'tomato_rt',
      csrfToken: 'tomato_csrf',
    });

    const prodRes = createAuthJsonResponse({ ok: true });
    setAuthCookies(
      prodRes,
      {
        accessToken: 'synthetic-at',
        refreshToken: 'synthetic-rt',
        csrfToken: 'synthetic-csrf-token-value-at-least-32-chars',
      },
      { isProduction: true },
    );

    const setCookies = prodRes.headers.getSetCookie();
    expect(
      setCookies.some(
        (c) =>
          c.startsWith('__Host-tomato_at=') &&
          c.includes('HttpOnly') &&
          c.includes('Secure') &&
          c.includes('SameSite=lax'),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (c) => c.startsWith('__Host-tomato_rt=') && c.includes('HttpOnly') && c.includes('Secure'),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (c) =>
          c.startsWith('__Host-tomato_csrf=') && !c.includes('HttpOnly') && c.includes('Secure'),
      ),
    ).toBe(true);
    expect(setCookies.every((c) => !c.includes('Domain='))).toBe(true);

    const clearedRes = createAuthJsonResponse({ ok: true });
    clearAuthCookies(clearedRes, { isProduction: true, clearCsrf: true });
    const clearedHeaders = clearedRes.headers.getSetCookie();
    expect(clearedHeaders.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('createErrorResponse trả đúng cấu trúc { error: { code, message, details } }, Cache-Control: no-store và Retry-After', async () => {
    const schema = z.object({ password: z.string().min(12, 'Tối thiểu 12 ký tự') });
    const parsed = schema.safeParse({ password: 'short' });
    expect(parsed.success).toBe(false);

    const details = parsed.success ? [] : formatZodErrorDetails(parsed.error);
    const res = createErrorResponse({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.',
      details,
      retryAfterSeconds: 42,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    expect(res.headers.get('Retry-After')).toBe('42');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.',
        details: [{ field: 'password', message: 'Tối thiểu 12 ký tự' }],
      },
    });
  });

  it('buildContentSecurityPolicy không bao giờ chứa unsafe-eval khi isProduction=true', () => {
    const csp = buildContentSecurityPolicy({
      nonce: 'abc123nonce',
      isProduction: true,
      isHttps: false,
      isApiRoute: false,
    });
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
