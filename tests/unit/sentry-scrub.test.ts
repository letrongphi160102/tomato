import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';

import {
  SENTRY_PRIVACY_DATA_COLLECTION,
  extractSentryIngestOrigin,
  isThirdPartyBrowserNoiseEvent,
  scrubSensitiveString,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@/core/monitoring/sentry-scrub';

describe('Unit M5: Sentry beforeSend / beforeBreadcrumb PII & Secret Scrubber', () => {
  it('SENTRY_PRIVACY_DATA_COLLECTION tắt toàn bộ thu thập tự động PII/cookie/header/body/query/DB params', () => {
    expect(SENTRY_PRIVACY_DATA_COLLECTION).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });
  it('extractSentryIngestOrigin chỉ trích xuất đúng origin HTTPS từ DSN và loại bỏ public key', () => {
    expect(
      extractSentryIngestOrigin('https://abc123def456@o987654.ingest.us.sentry.io/45000001'),
    ).toBe('https://o987654.ingest.us.sentry.io');
    expect(extractSentryIngestOrigin('http://insecure@example.com/1')).toBeNull();
    expect(extractSentryIngestOrigin('')).toBeNull();
    expect(extractSentryIngestOrigin(undefined)).toBeNull();
    expect(extractSentryIngestOrigin('not-a-url')).toBeNull();
  });

  it('scrubSensitiveString lọc sạch JWT, Bearer, Argon2 hash, cookie phiên, DB/Redis URL, query token và email', () => {
    // Tạo chuỗi JWT giả lập ở runtime để không lưu literal dạng JWT thật dễ kích hoạt nhầm rule `jwt` của Gitleaks.
    const syntheticJwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const syntheticJwtPayload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString(
      'base64url',
    );
    const jwt = [syntheticJwtHeader, syntheticJwtPayload, 'signaturePart999'].join('.');
    const argon2Hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdDEyMzQ1Njc4$hashvalue987654321';
    const raw = [
      `Authorization: Bearer ${jwt}`,
      `Cookie: __Host-tomato_rt=secret-refresh-token-value; tomato_csrf=csrf-secret-999`,
      `Reset: https://tomato.app/reset-password?token=raw-reset-token-256bit&foo=bar`,
      `Hash: ${argon2Hash}`,
      `DB: postgresql://tomato:supersecret@ep-demo.ap-southeast-1.aws.neon.tech/neondb`,
      `Redis: rediss://default:redissecret@demo.upstash.io:6379`,
      `User: alice.nguyen@gmail.com`,
    ].join(' | ');

    const cleaned = scrubSensitiveString(raw);
    expect(cleaned).not.toContain(jwt);
    expect(cleaned).not.toContain('secret-refresh-token-value');
    expect(cleaned).not.toContain('csrf-secret-999');
    expect(cleaned).not.toContain('raw-reset-token-256bit');
    expect(cleaned).not.toContain(argon2Hash);
    expect(cleaned).not.toContain('supersecret');
    expect(cleaned).not.toContain('redissecret');
    expect(cleaned).not.toContain('alice.nguyen@gmail.com');
    expect(cleaned).toContain('foo=bar');
  });

  it('scrubSentryEvent (beforeSend) xóa sạch cookies, header nhạy cảm, body mật khẩu/OTP/email, user PII và hỗ trợ circular object', () => {
    const circularExtra: Record<string, unknown> = {
      password: 'MySuperSecretPassword123!',
      nested: {
        otpCode: '849201',
        refreshToken: 'opaque-rt-secret-value',
        safeNote: 'Error for bob@example.com on /reset-password?token=reset-abc-999',
      },
    };
    circularExtra.self = circularExtra;

    const rawEvent: ErrorEvent = {
      type: undefined,
      message: 'Failed login for bob@example.com with Bearer secret-bearer-token-xyz',
      user: {
        id: 'public-id-uuidv4-safe',
        email: 'bob@example.com',
        username: 'bob_nguyen',
        ip_address: '203.0.113.42',
      },
      request: {
        url: 'https://tomato.app/reset-password?token=secret-reset-link-token&step=confirm',
        query_string: 'token=secret-reset-link-token&otp=654321&lang=vi',
        cookies: {
          '__Host-tomato_at': 'jwt-cookie-val',
          '__Host-tomato_rt': 'rt-cookie-val',
        },
        headers: {
          Cookie: '__Host-tomato_rt=rt-cookie-val',
          Authorization: 'Bearer secret-jwt-header',
          'X-CSRF-Token': 'csrf-header-secret',
          'X-Forwarded-For': '203.0.113.42',
          'User-Agent': 'Mozilla/5.0',
        },
        data: JSON.stringify({
          email: 'bob@example.com',
          password: 'MySuperSecretPassword123!',
          otpCode: '654321',
          captchaToken: 'turnstile-token-secret',
          action: 'login',
        }),
      },
      exception: {
        values: [
          {
            type: 'Error',
            value:
              'DB error on postgresql://tomato:dbpass999@host/db for bob@example.com with $argon2id$v=19$m=19456$abc$xyz',
          },
        ],
      },
      extra: circularExtra,
      tags: {
        component: 'auth-api',
        email: 'bob@example.com',
      },
      breadcrumbs: [
        {
          category: 'fetch',
          message: 'POST /api/v1/auth/reset-password?token=crumb-secret-token',
          data: {
            url: 'https://tomato.app/reset-password?token=crumb-secret-token',
            authorization: 'Bearer crumb-bearer-secret',
            status_code: 500,
          },
        },
      ],
    };

    const scrubbed = scrubSentryEvent(rawEvent);
    const serialized = JSON.stringify(scrubbed);

    const forbiddenValues = [
      'MySuperSecretPassword123!',
      '849201',
      '654321',
      'opaque-rt-secret-value',
      'bob@example.com',
      'bob_nguyen',
      '203.0.113.42',
      'secret-bearer-token-xyz',
      'secret-reset-link-token',
      'jwt-cookie-val',
      'rt-cookie-val',
      'secret-jwt-header',
      'csrf-header-secret',
      'turnstile-token-secret',
      'dbpass999',
      '$argon2id$',
      'crumb-secret-token',
      'crumb-bearer-secret',
    ];

    for (const secret of forbiddenValues) {
      expect(serialized).not.toContain(secret);
    }

    // Xác minh thông tin chẩn đoán kỹ thuật an toàn vẫn được giữ lại.
    expect(scrubbed.user).toEqual({ id: 'public-id-uuidv4-safe' });
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.headers?.['User-Agent']).toBe('Mozilla/5.0');
    expect(scrubbed.tags?.component).toBe('auth-api');
    expect(scrubbed.tags?.email).toBe('[REDACTED]');
    expect(scrubbed.breadcrumbs?.[0]?.data?.status_code).toBe(500);
  });

  it('scrubSentryBreadcrumb lọc URL & payload nhạy cảm trong breadcrumb điều hướng/fetch', () => {
    const crumb: Breadcrumb = {
      category: 'navigation',
      message: 'Navigated to /reset-password?token=nav-secret-token',
      data: {
        from: '/forgot-password?email=owner@tomato.test',
        to: '/reset-password?token=nav-secret-token',
        cookie: 'tomato_rt=secret-rt',
      },
    };

    const cleaned = scrubSentryBreadcrumb(crumb);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain('nav-secret-token');
    expect(serialized).not.toContain('owner@tomato.test');
    expect(serialized).not.toContain('secret-rt');
  });

  it('Audit Q5: lọc Drizzle params, SMTP AUTH, inline JSON/header bí mật, logentry, transaction và stack frame vars', () => {
    const drizzleErr =
      'Failed query: insert into "verification_tokens" values ($1,$2,$3)\nparams: 01950000-0000-7000-8000-000000000001,secret-hash-hex-64,849201';
    const smtpErr = 'SMTP failed at AUTH PLAIN dXNlcjpzdXBlcl9zZWNyZXQ=';
    const inlineJsonErr =
      'Bad payload {"password":"RawPassValue123!","otpCode":"998877","ticket":"ticket-secret-val"}';
    const inlineHeaderErr = 'Proxy error X-CSRF-Token: csrf-secret-xyz | Api-Key: brevo-secret-key';

    const cleanedDrizzle = scrubSensitiveString(drizzleErr);
    expect(cleanedDrizzle).not.toContain('secret-hash-hex-64');
    expect(cleanedDrizzle).not.toContain('849201');
    expect(cleanedDrizzle).toContain('params: [REDACTED]');

    const cleanedSmtp = scrubSensitiveString(smtpErr);
    expect(cleanedSmtp).not.toContain('dXNlcjpzdXBlcl9zZWNyZXQ=');
    expect(cleanedSmtp).toContain('AUTH PLAIN [REDACTED]');

    const cleanedJson = scrubSensitiveString(inlineJsonErr);
    expect(cleanedJson).not.toContain('RawPassValue123!');
    expect(cleanedJson).not.toContain('998877');
    expect(cleanedJson).not.toContain('ticket-secret-val');

    const cleanedHeader = scrubSensitiveString(inlineHeaderErr);
    expect(cleanedHeader).not.toContain('csrf-secret-xyz');
    expect(cleanedHeader).not.toContain('brevo-secret-key');

    const eventWithFrameVars: ErrorEvent = {
      type: undefined,
      transaction: 'GET /reset-password?token=tx-secret-token&otp_code=112233',
      logentry: {
        message: 'Failure with ?ticket=log-ticket-secret&csrfToken=log-csrf-secret',
        params: ['Bearer log-bearer-secret'],
      },
      exception: {
        values: [
          {
            type: 'DrizzleQueryError',
            value: drizzleErr,
            stacktrace: {
              frames: [
                {
                  filename: 'auth.service.ts',
                  vars: {
                    rawPassword: 'LocalFramePassword!',
                    otpCode: '654321',
                  },
                },
              ],
            },
          },
        ],
      },
    };

    const scrubbed = scrubSentryEvent(eventWithFrameVars);
    const serialized = JSON.stringify(scrubbed);
    for (const secret of [
      'tx-secret-token',
      '112233',
      'log-ticket-secret',
      'log-csrf-secret',
      'log-bearer-secret',
      'secret-hash-hex-64',
      'LocalFramePassword!',
      '654321',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
  });

  it('chặn thông báo lỗi giả từ script tiêm của Zalo In-App WebView (`zaloJSV2 is not defined`)', () => {
    const zaloNoiseEvent: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'ReferenceError',
            value: 'zaloJSV2 is not defined',
          },
        ],
      },
    };
    const appRealEvent: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'Cannot read properties of undefined',
          },
        ],
      },
    };

    expect(isThirdPartyBrowserNoiseEvent(zaloNoiseEvent)).toBe(true);
    expect(isThirdPartyBrowserNoiseEvent(appRealEvent)).toBe(false);
  });
});
