import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '@/core/config/env';

function createBaseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: 'http://localhost:3000, http://127.0.0.1:3000/callback',
    LOG_LEVEL: 'debug',
    DATABASE_URL: 'postgresql://tomato:tomato_dev_password@127.0.0.1:5432/tomato_dev',
    DB_POOL_MAX: '10',
    REDIS_PROVIDER: 'local',
    REDIS_URL: 'redis://127.0.0.1:6379',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    JWT_SECRET: 'unit-test-only-jwt-secret-value-at-least-32-chars',
    OTP_SECRET: 'unit-test-only-otp-secret-value-at-least-32-chars',
    CURRENT_PEPPER_VERSION: '1',
    PASSWORD_PEPPER_SECRETS: JSON.stringify({
      '1': 'unit-test-only-pepper-v1-secret-at-least-32-chars',
    }),
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'Tomato <no-reply@tomato.local>',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    SMTP_USER: '',
    SMTP_PASS: '',
    BREVO_API_KEY: '',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_DSN: '',
    ...overrides,
  };
}

describe('parseEnv (fail-fast Zod validation)', () => {
  it('chấp nhận cấu hình local dev đầy đủ và chuẩn hóa giá trị', () => {
    const env = parseEnv(createBaseEnv());

    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_PROVIDER).toBe('local');
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.ALLOWED_ORIGINS).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(env.PASSWORD_PEPPER_SECRETS[1]).toBe(
      'unit-test-only-pepper-v1-secret-at-least-32-chars',
    );
    expect(env.SENTRY_DSN).toBeUndefined();

    const withDefaultSecure = parseEnv(createBaseEnv({ SMTP_SECURE: '' }));
    expect(withDefaultSecure.SMTP_SECURE).toBe(false);

    const withTrueSecure = parseEnv(createBaseEnv({ SMTP_SECURE: 'true' }));
    expect(withTrueSecure.SMTP_SECURE).toBe(true);
  });

  it('chấp nhận cấu hình production hợp lệ với Upstash và Brevo', () => {
    const env = parseEnv(
      createBaseEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://tomato.example.com',
        ALLOWED_ORIGINS: undefined,
        LOG_LEVEL: undefined,
        REDIS_PROVIDER: 'upstash',
        REDIS_URL: undefined,
        UPSTASH_REDIS_REST_URL: 'https://example-upstash.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'synthetic-upstash-token-for-unit-test',
        EMAIL_PROVIDER: 'brevo',
        SMTP_HOST: undefined,
        SMTP_PORT: undefined,
        BREVO_API_KEY: 'synthetic-brevo-key-for-unit-test',
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'prod-site-key-non-dummy',
        TURNSTILE_SECRET_KEY: 'prod-secret-key-non-dummy',
      }),
    );

    expect(env.NODE_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.REDIS_PROVIDER).toBe('upstash');
    expect(env.EMAIL_PROVIDER).toBe('brevo');
    expect(env.ALLOWED_ORIGINS).toEqual(['https://tomato.example.com']);
  });

  it('fail-fast khi JWT_SECRET ngắn hơn 32 ký tự và không in giá trị secret ra lỗi', () => {
    const shortSecret = 'too-short-secret-value';

    try {
      parseEnv(createBaseEnv({ JWT_SECRET: shortSecret }));
      expect.unreachable('Phải ném EnvValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.issues.some((issue) => issue.path === 'JWT_SECRET')).toBe(true);
      expect(err.message).not.toContain(shortSecret);
    }
  });

  it('fail-fast khi OTP_SECRET trùng với JWT_SECRET', () => {
    const sharedSecret = 'unit-test-shared-secret-value-at-least-32-chars';

    expect(() =>
      parseEnv(createBaseEnv({ JWT_SECRET: sharedSecret, OTP_SECRET: sharedSecret })),
    ).toThrow(EnvValidationError);
  });

  it('fail-fast khi CURRENT_PEPPER_VERSION không có trong PASSWORD_PEPPER_SECRETS', () => {
    expect(() =>
      parseEnv(
        createBaseEnv({
          CURRENT_PEPPER_VERSION: '2',
          PASSWORD_PEPPER_SECRETS: JSON.stringify({
            '1': 'unit-test-only-pepper-v1-secret-at-least-32-chars',
          }),
        }),
      ),
    ).toThrow(EnvValidationError);
  });

  it('fail-fast khi REDIS_PROVIDER=upstash nhưng thiếu thông tin kết nối Upstash', () => {
    expect(() =>
      parseEnv(
        createBaseEnv({
          REDIS_PROVIDER: 'upstash',
          UPSTASH_REDIS_REST_URL: '',
          UPSTASH_REDIS_REST_TOKEN: '',
        }),
      ),
    ).toThrow(EnvValidationError);
  });

  it('chặn APP_URL dùng http://, SMTP thiếu credentials và Turnstile dummy key trong production', () => {
    try {
      parseEnv(
        createBaseEnv({
          NODE_ENV: 'production',
          APP_URL: 'http://tomato.example.com',
          SMTP_USER: '',
          SMTP_PASS: '',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        }),
      );
      expect.unreachable('Phải ném EnvValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const paths = (error as EnvValidationError).issues.map((i) => i.path);
      expect(paths).toContain('APP_URL');
      expect(paths).toContain('SMTP_USER');
      expect(paths).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY');
      expect(paths).toContain('TURNSTILE_SECRET_KEY');
    }
  });

  it('M5: hỗ trợ EMAIL_PROVIDER=mailpit|gmail|brevo, chặn mailpit trên production và ép credentials cho gmail', () => {
    const localMailpit = parseEnv(
      createBaseEnv({
        EMAIL_PROVIDER: 'mailpit',
        SMTP_HOST: '',
        SMTP_PORT: '',
      }),
    );
    expect(localMailpit.EMAIL_PROVIDER).toBe('mailpit');

    const prodGmail = parseEnv(
      createBaseEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://tomato.example.com',
        EMAIL_PROVIDER: 'gmail',
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_USER: 'tomato.demo@gmail.com',
        SMTP_PASS: 'synthetic-app-password-16ch',
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'prod-site-key-non-dummy',
        TURNSTILE_SECRET_KEY: 'prod-secret-key-non-dummy',
      }),
    );
    expect(prodGmail.EMAIL_PROVIDER).toBe('gmail');

    expect(() =>
      parseEnv(
        createBaseEnv({
          NODE_ENV: 'production',
          APP_URL: 'https://tomato.example.com',
          EMAIL_PROVIDER: 'mailpit',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'prod-site-key-non-dummy',
          TURNSTILE_SECRET_KEY: 'prod-secret-key-non-dummy',
        }),
      ),
    ).toThrow(EnvValidationError);

    expect(() =>
      parseEnv(
        createBaseEnv({
          EMAIL_PROVIDER: 'gmail',
          SMTP_USER: '',
          SMTP_PASS: '',
        }),
      ),
    ).toThrow(EnvValidationError);
  });
});
