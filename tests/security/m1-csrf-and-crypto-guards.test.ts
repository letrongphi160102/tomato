import { describe, expect, it } from 'vitest';

import { generateSecureToken } from '@/core/crypto/token';
import { CSRF_HEADER_NAME, enforceCsrfAndOrigin, verifyCsrfAndOrigin } from '@/core/security/csrf';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';

const ALLOWED_ORIGINS = ['https://tomato.example.com'];

describe('Security M1: CSRF Guard (Origin + Sec-Fetch-Site + Double-Submit Token)', () => {
  it('cho phép các phương thức chỉ đọc (GET/HEAD/OPTIONS)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const request = new Request('https://tomato.example.com/api/v1/auth/me', { method });
      expect(verifyCsrfAndOrigin(request, { allowedOrigins: ALLOWED_ORIGINS })).toEqual({
        valid: true,
      });
    }
  });

  it('chấp nhận request POST/DELETE hợp lệ khi đủ Origin + Sec-Fetch-Site + Double-Submit CSRF Token', () => {
    const csrfToken = generateSecureToken();
    const request = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://tomato.example.com',
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER_NAME]: csrfToken,
        cookie: `__Host-tomato_csrf=${csrfToken}; __Host-tomato_at=synthetic-at`,
      },
    });

    expect(
      verifyCsrfAndOrigin(request, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: true,
      }),
    ).toEqual({ valid: true });

    expect(
      enforceCsrfAndOrigin(request, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: true,
      }),
    ).toBeNull();
  });

  it('chặn request POST từ cross-site (Sec-Fetch-Site: cross-site) hoặc sai Origin', async () => {
    const csrfToken = generateSecureToken();

    const crossSiteReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://tomato.example.com',
        'sec-fetch-site': 'cross-site',
        [CSRF_HEADER_NAME]: csrfToken,
        cookie: `tomato_csrf=${csrfToken}`,
      },
    });
    expect(
      verifyCsrfAndOrigin(crossSiteReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'SEC_FETCH_SITE_REJECTED' });

    const wrongOriginReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.attacker.invalid',
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER_NAME]: csrfToken,
        cookie: `tomato_csrf=${csrfToken}`,
      },
    });
    expect(
      verifyCsrfAndOrigin(wrongOriginReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'ORIGIN_MISMATCH' });

    const blockedResponse = enforceCsrfAndOrigin(wrongOriginReq, {
      allowedOrigins: ALLOWED_ORIGINS,
      isProduction: false,
    });
    expect(blockedResponse?.status).toBe(403);
    expect(blockedResponse?.headers.get('Cache-Control')).toBe(AUTH_CACHE_CONTROL_HEADER);
    const body = (await blockedResponse?.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('chặn request thay đổi dữ liệu khi thiếu Origin hoặc thiếu/sai Double-Submit CSRF Token', () => {
    const csrfToken = generateSecureToken();
    const otherCsrfToken = generateSecureToken();

    const missingOriginReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'DELETE',
      headers: {
        [CSRF_HEADER_NAME]: csrfToken,
        cookie: `tomato_csrf=${csrfToken}`,
      },
    });
    expect(
      verifyCsrfAndOrigin(missingOriginReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'MISSING_ORIGIN' });

    const missingHeaderReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://tomato.example.com',
        'sec-fetch-site': 'same-origin',
        cookie: `tomato_csrf=${csrfToken}`,
      },
    });
    expect(
      verifyCsrfAndOrigin(missingHeaderReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'MISSING_CSRF_TOKEN' });

    const mismatchTokenReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://tomato.example.com',
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER_NAME]: otherCsrfToken,
        cookie: `tomato_csrf=${csrfToken}`,
      },
    });
    expect(
      verifyCsrfAndOrigin(mismatchTokenReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'CSRF_TOKEN_MISMATCH' });

    // Token quá ngắn (< 32 ký tự) dù giống nhau cũng phải bị từ chối.
    const weakTokenReq = new Request('https://tomato.example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://tomato.example.com',
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER_NAME]: 'short-csrf',
        cookie: 'tomato_csrf=short-csrf',
      },
    });
    expect(
      verifyCsrfAndOrigin(weakTokenReq, {
        allowedOrigins: ALLOWED_ORIGINS,
        isProduction: false,
      }),
    ).toMatchObject({ valid: false, reason: 'INVALID_CSRF_TOKEN' });
  });
});
