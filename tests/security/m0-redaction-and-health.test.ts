import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@/core/logger';

describe('Security M0: Pino redact chống rò rỉ dữ liệu nhạy cảm', () => {
  it('che toàn bộ password, token, otp, cookie, authorization ở cả top-level, nested và HTTP headers', () => {
    const chunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createLogger({
      level: 'debug',
      pretty: false,
      destination: memoryStream,
    });

    const secrets = [
      'SecretPass_Alpha_123!',
      'SecretPass_Old_456!',
      'SecretPass_New_789!',
      'synthetic-bearer-jwt-value',
      'synthetic-refresh-token-value',
      '849201',
      'synthetic-turnstile-captcha',
      'synthetic-pepper-material',
      '__Host-tomato_rt=synthetic-cookie-value',
      'synthetic-csrf-header-value',
    ];

    testLogger.info(
      {
        password: secrets[0],
        currentPassword: secrets[1],
        newPassword: secrets[2],
        token: secrets[3],
        refreshToken: secrets[4],
        otp: secrets[5],
        captchaToken: secrets[6],
        pepper: secrets[7],
        payload: {
          password: secrets[0],
          otpCode: secrets[5],
          nested: {
            accessToken: secrets[3],
            secret: secrets[7],
          },
        },
        req: {
          headers: {
            authorization: `Bearer ${secrets[3]}`,
            cookie: secrets[8],
            'x-csrf-token': secrets[9],
          },
        },
        res: {
          headers: {
            'set-cookie': `${secrets[8]}; HttpOnly; Secure`,
          },
        },
      },
      'Kiểm thử redact dữ liệu nhạy cảm',
    );

    const rawOutput = chunks.join('');
    expect(rawOutput.length).toBeGreaterThan(0);

    for (const leakedCandidate of secrets) {
      expect(rawOutput).not.toContain(leakedCandidate);
    }

    const parsed = JSON.parse(rawOutput.trim()) as Record<string, unknown>;
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.currentPassword).toBe('[REDACTED]');
    expect(parsed.newPassword).toBe('[REDACTED]');
    expect(parsed.token).toBe('[REDACTED]');
    expect(parsed.refreshToken).toBe('[REDACTED]');
    expect(parsed.otp).toBe('[REDACTED]');
    expect(parsed.captchaToken).toBe('[REDACTED]');
    expect(parsed.pepper).toBe('[REDACTED]');

    const req = parsed.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe('[REDACTED]');
    expect(req.headers.cookie).toBe('[REDACTED]');
    expect(req.headers['x-csrf-token']).toBe('[REDACTED]');

    const res = parsed.res as { headers: Record<string, unknown> };
    expect(res.headers['set-cookie']).toBe('[REDACTED]');
  });

  it('che cả csrfToken, tokenHash, refreshTokenHash, smtpPass, DATABASE_URL và biến thể hoa/thường HTTP headers', () => {
    const chunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createLogger({
      level: 'debug',
      pretty: false,
      destination: memoryStream,
    });

    const extraSecrets = [
      'synthetic-csrf-token-value-32chars',
      'synthetic-refresh-token-hash-hex64',
      'synthetic-otp-token-hash-hex64',
      'synthetic-smtp-app-password',
      'postgresql://tomato:synthetic-db-pass@127.0.0.1:5432/tomato',
      '__Host-tomato_at=synthetic-at-cookie',
      'https://tomato.example.com/reset-password?token=synthetic-reset-token-256bit',
    ];

    testLogger.error(
      {
        csrfToken: extraSecrets[0],
        resetUrl: extraSecrets[6],
        session: {
          refreshTokenHash: extraSecrets[1],
          otpTokenHash: extraSecrets[2],
        },
        config: {
          smtpPass: extraSecrets[3],
          DATABASE_URL: extraSecrets[4],
        },
        req: {
          headers: {
            Cookie: extraSecrets[5],
            'X-CSRF-Token': extraSecrets[0],
          },
        },
        res: {
          headers: {
            'Set-Cookie': `${extraSecrets[5]}; HttpOnly; Secure`,
          },
        },
      },
      'Kiểm thử redact khóa mở rộng',
    );

    const rawOutput = chunks.join('');
    for (const secret of extraSecrets) {
      expect(rawOutput).not.toContain(secret);
    }

    const parsed = JSON.parse(rawOutput.trim()) as Record<string, unknown>;
    expect(parsed.csrfToken).toBe('[REDACTED]');
    const req = parsed.req as { headers: Record<string, unknown> };
    expect(req.headers.Cookie).toBe('[REDACTED]');
    expect(req.headers['X-CSRF-Token']).toBe('[REDACTED]');
    const res = parsed.res as { headers: Record<string, unknown> };
    expect(res.headers['Set-Cookie']).toBe('[REDACTED]');
  });
});

describe('Security M0: /api/health không lộ chi tiết hạ tầng khi dịch vụ lỗi', () => {
  it('trả 503 gọn nhẹ và không rò rỉ connection string, password hoặc stack trace', async () => {
    vi.resetModules();

    vi.doMock('@/core/db', () => ({
      checkDatabaseHealth: vi.fn(async () => false),
    }));
    vi.doMock('@/core/redis', () => ({
      checkRedisHealth: vi.fn(async () => false),
    }));

    const { GET } = await import('@/app/api/health/route');
    const response = await GET();
    const rawBody = await response.text();
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(Object.keys(parsed).sort()).toEqual(['checks', 'status', 'timestamp']);
    expect(rawBody).not.toMatch(/postgres|redis:\/\/|stack|Error:|ECONNREFUSED|password/i);

    vi.doUnmock('@/core/db');
    vi.doUnmock('@/core/redis');
  });
});
