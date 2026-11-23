import { describe, expect, it, vi } from 'vitest';

import type { DbExecutor } from '@/core/db';
import {
  AuditLogService,
  normalizeIpAddress,
  sanitizeAuditMetadata,
} from '@/core/security/audit-log.service';

describe('AuditLogService & Metadata Sanitization', () => {
  it('loại bỏ hoàn toàn mọi trường nhạy cảm (password, otp, token, cookie, secret...) ở mọi tầng lồng nhau', () => {
    // Tạo chuỗi JWT giả lập ở runtime để không lưu literal dạng JWT thật dễ kích hoạt nhầm rule `jwt` của Gitleaks.
    const syntheticJwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const syntheticJwtPayload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString(
      'base64url',
    );
    const syntheticJwt = [syntheticJwtHeader, syntheticJwtPayload, 'signature123456789'].join('.');

    const sanitized = sanitizeAuditMetadata({
      reason: 'invalid_password',
      attemptNumber: 3,
      password: 'SuperSecretPassword123!',
      otpCode: '123456',
      refreshToken: 'opaque-refresh-token',
      authorization: `Bearer ${syntheticJwt}`,
      nested: {
        device: 'Chrome / Windows',
        cookie: '__Host-tomato_rt=leak',
        pepperSecret: 'pepper-v1-secret',
        leakedBearerInSafeKey: 'Bearer synthetic-bearer-token-value',
        leakedEmbeddedBearerInSafeKey: 'Upstream failed: Bearer embedded-bearer-secret',
        leakedJwtInSafeKey: syntheticJwt,
        leakedEmbeddedJwtInSafeKey: `Token rejected: ${syntheticJwt}`,
        leakedArgon2InSafeKey: '$argon2id$v=19$m=19456,t=2,p=1$salt$digest',
        leakedSessionValInSafeKey: '__Host-tomato_rt=synthetic-leaked-value',
        leakedResetUrlInSafeKey: 'https://tomato.example.com/reset-password?token=secret-reset-val',
        leakedQueryUrlInSafeKey: 'https://tomato.example.com/verify?otpCode=654321',
      },
    });

    expect(sanitized).toEqual({
      reason: 'invalid_password',
      attemptNumber: 3,
      nested: {
        device: 'Chrome / Windows',
        leakedBearerInSafeKey: '[REDACTED]',
        leakedEmbeddedBearerInSafeKey: '[REDACTED]',
        leakedJwtInSafeKey: '[REDACTED]',
        leakedEmbeddedJwtInSafeKey: '[REDACTED]',
        leakedArgon2InSafeKey: '[REDACTED]',
        leakedSessionValInSafeKey: '[REDACTED]',
        leakedResetUrlInSafeKey: '[REDACTED]',
        leakedQueryUrlInSafeKey: '[REDACTED]',
      },
    });
  });

  it('chuẩn hóa địa chỉ IPv4/IPv6 hợp lệ và trả null an toàn cho chuỗi IP sai định dạng', () => {
    expect(normalizeIpAddress('203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeIpAddress('203.0.113.10, 10.0.0.1')).toBe('203.0.113.10');
    expect(normalizeIpAddress('[::1]')).toBe('::1');
    expect(normalizeIpAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIpAddress('not-an-ip-address')).toBeNull();
    expect(normalizeIpAddress('')).toBeNull();
  });

  it('AuditLogService.record ghi bản ghi với UUIDv7, IP đã chuẩn hóa và metadata đã vệ sinh', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async (row: unknown) => {
          insertedValues.push(row);
        }),
      })),
    } as unknown as DbExecutor;

    const service = new AuditLogService(() => mockDb);

    const result = await service.record({
      userId: null,
      action: 'LOGIN_FAILED',
      ipAddress: '198.51.100.42, 10.0.0.5',
      userAgent: 'Mozilla/5.0 TestAgent',
      metadata: {
        emailDomain: 'example.com',
        password: 'MustNotBeStoredPassword!',
        otp: '654321',
      },
    });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toEqual({
      id: result.id,
      userId: null,
      action: 'LOGIN_FAILED',
      ipAddress: '198.51.100.42',
      userAgent: 'Mozilla/5.0 TestAgent',
      metadata: {
        emailDomain: 'example.com',
      },
    });
  });
});
