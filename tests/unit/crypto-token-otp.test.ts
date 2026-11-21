import { describe, expect, it } from 'vitest';

import { generateOtpCode, hashOtpCode, verifyOtpCode } from '@/core/crypto/otp';
import {
  generateSecureToken,
  hashTokenSha256,
  timingSafeEqualHex,
  timingSafeEqualUtf8,
  verifyTokenHash,
} from '@/core/crypto/token';

const TEST_OTP_SECRET = 'unit-test-only-otp-secret-value-at-least-32-chars';
const OTHER_OTP_SECRET = 'unit-test-only-different-otp-secret-at-least-32-chars';

describe('Token crypto (256-bit random + SHA-256 + timingSafeEqual)', () => {
  it('sinh token ngẫu nhiên >= 256-bit dạng base64url và từ chối độ dài dưới 32 bytes', () => {
    const tokenA = generateSecureToken();
    const tokenB = generateSecureToken(48);

    expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenB).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(tokenA).not.toBe(tokenB);

    expect(() => generateSecureToken(16)).toThrow(RangeError);
    expect(() => generateSecureToken(31)).toThrow(RangeError);
  });

  it('băm SHA-256 ra 64 ký tự hex và xác minh bằng so sánh hằng thời gian', () => {
    const token = generateSecureToken();
    const digest = hashTokenSha256(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTokenHash(token, digest)).toBe(true);
    expect(verifyTokenHash(`${token}x`, digest)).toBe(false);
    expect(verifyTokenHash(token, '0'.repeat(64))).toBe(false);
    expect(verifyTokenHash(token, 'too-short')).toBe(false);
  });

  it('timingSafeEqualHex & timingSafeEqualUtf8 từ chối chuỗi khác độ dài hoặc sai định dạng an toàn', () => {
    expect(timingSafeEqualHex('aabbcc', 'AABBCC')).toBe(true);
    expect(timingSafeEqualHex('aabbcc', 'aabbcd')).toBe(false);
    expect(timingSafeEqualHex('aabb', 'aabbcc')).toBe(false);
    expect(timingSafeEqualHex('zzzzzz', 'zzzzzz')).toBe(false);

    expect(timingSafeEqualUtf8('same-token-value', 'same-token-value')).toBe(true);
    expect(timingSafeEqualUtf8('same-token-value', 'diff-token-value')).toBe(false);
    expect(timingSafeEqualUtf8('short', 'longer-value')).toBe(false);
    expect(timingSafeEqualUtf8('', '')).toBe(false);
  });
});

describe('OTP crypto (crypto.randomInt + HMAC-SHA256 + domain separation + timingSafeEqual)', () => {
  it('generateOtpCode luôn sinh đúng 6 chữ số kể cả số 0 ở đầu', () => {
    const codes = Array.from({ length: 100 }, () => generateOtpCode());
    for (const code of codes) {
      expect(code).toMatch(/^\d{6}$/);
    }
    expect(new Set(codes).size).toBeGreaterThan(50);
  });

  it('băm HMAC-SHA256 với OTP_SECRET và xác minh đúng/sai với domain separation', () => {
    const context = {
      userId: '01936c0a-5e0c-7b3a-8f9d-2e1c4a6b8d0f',
      purpose: 'email_verify' as const,
    };

    const otp = '004219';
    const hash = hashOtpCode(otp, context, TEST_OTP_SECRET);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOtpCode(otp, hash, context, TEST_OTP_SECRET)).toBe(true);

    // Sai mã OTP
    expect(verifyOtpCode('004218', hash, context, TEST_OTP_SECRET)).toBe(false);
    // Sai format OTP
    expect(verifyOtpCode('4219', hash, context, TEST_OTP_SECRET)).toBe(false);
    expect(verifyOtpCode('abcdef', hash, context, TEST_OTP_SECRET)).toBe(false);
    // Sai OTP_SECRET
    expect(verifyOtpCode(otp, hash, context, OTHER_OTP_SECRET)).toBe(false);
    // Khác userId không được phép khớp dù cùng 6 chữ số (domain separation)
    expect(
      verifyOtpCode(
        otp,
        hash,
        { userId: '01936c0a-5e0c-7b3a-8f9d-999999999999', purpose: 'email_verify' },
        TEST_OTP_SECRET,
      ),
    ).toBe(false);
    // Khác purpose không được phép khớp chéo (email_verify vs password_change)
    expect(
      verifyOtpCode(
        otp,
        hash,
        { userId: context.userId, purpose: 'password_change' },
        TEST_OTP_SECRET,
      ),
    ).toBe(false);
  });
});
