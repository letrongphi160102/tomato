import { describe, expect, it } from 'vitest';

import { normalizePostgresConnectionString } from '@/core/db/connection-string';

describe('Unit: normalizePostgresConnectionString (tự nâng sslmode -> verify-full cho Neon/pg)', () => {
  it('tự động nâng sslmode=require, prefer, verify-ca lên verify-full và giữ nguyên tham số khác', () => {
    expect(
      normalizePostgresConnectionString(
        'postgresql://user:pass@ep-cool-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      ),
    ).toBe(
      'postgresql://user:pass@ep-cool-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require',
    );

    expect(
      normalizePostgresConnectionString('postgresql://user:pass@db.example.com/app?sslmode=prefer'),
    ).toBe('postgresql://user:pass@db.example.com/app?sslmode=verify-full');

    expect(
      normalizePostgresConnectionString(
        'postgresql://user:pass@db.example.com/app?sslmode=verify-ca',
      ),
    ).toBe('postgresql://user:pass@db.example.com/app?sslmode=verify-full');
  });

  it('giữ nguyên URL cục bộ, sslmode=disable, sslmode=verify-full hoặc khi bật uselibpqcompat=true', () => {
    const localUrl = 'postgresql://tomato:tomato_dev_password@127.0.0.1:5433/tomato_dev';
    expect(normalizePostgresConnectionString(localUrl)).toBe(localUrl);

    const disabledSslUrl = 'postgresql://tomato:pass@127.0.0.1:5432/app?sslmode=disable';
    expect(normalizePostgresConnectionString(disabledSslUrl)).toBe(disabledSslUrl);

    const alreadyVerifyFull = 'postgresql://user:pass@db.example.com/app?sslmode=verify-full';
    expect(normalizePostgresConnectionString(alreadyVerifyFull)).toBe(alreadyVerifyFull);

    const explicitLibpqCompat =
      'postgresql://user:pass@db.example.com/app?uselibpqcompat=true&sslmode=require';
    expect(normalizePostgresConnectionString(explicitLibpqCompat)).toBe(explicitLibpqCompat);
  });
});
