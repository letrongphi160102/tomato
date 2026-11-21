import { hash as rawArgon2Hash, parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import {
  PASSWORD_HASH_POLICY,
  hashPassword,
  needsPasswordRehash,
  verifyDummyPassword,
  verifyPassword,
  type PepperSecretProvider,
} from '@/core/crypto/password';

function createMockPepperProvider(
  currentVersion: number,
  secrets: Record<number, string>,
): PepperSecretProvider {
  return {
    getCurrentVersion: () => currentVersion,
    getPepper: (version) => secrets[version],
  };
}

const PEPPER_V1 = 'unit-test-only-pepper-v1-secret-at-least-32-chars';
const PEPPER_V2 = 'unit-test-only-pepper-v2-secret-at-least-32-chars';

describe('Password crypto: Argon2id + Pepper + Rehash + Dummy Verification', () => {
  it('băm bằng Argon2id đúng tham số OWASP (m=19456, t=2, p=1, outputLen=32) và xác minh đúng/sai', async () => {
    const provider = createMockPepperProvider(1, { 1: PEPPER_V1 });
    const rawPassword = '  Mật Khẩu Rất Dài Và An Toàn 2026!  ';

    const { hash, pepperVersion } = await hashPassword(rawPassword, provider);

    expect(pepperVersion).toBe(1);
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);

    const parsed = parseOptions(hash);
    expect(parsed.memoryCost).toBe(PASSWORD_HASH_POLICY.memoryCost);
    expect(parsed.timeCost).toBe(PASSWORD_HASH_POLICY.timeCost);
    expect(parsed.parallelism).toBe(PASSWORD_HASH_POLICY.parallelism);
    expect(parsed.outputLen).toBe(PASSWORD_HASH_POLICY.outputLen);
    expect(parsed.saltLen).toBeGreaterThanOrEqual(16);

    // Mật khẩu đúng (giữ nguyên khoảng trắng đầu/cuối) phải xác minh thành công và không cần rehash.
    const okResult = await verifyPassword(rawPassword, hash, pepperVersion, provider);
    expect(okResult).toEqual({ valid: true, needsRehash: false });

    // Nếu cắt khoảng trắng đầu/cuối phải thất bại (chứng minh không trim mật khẩu).
    const trimmedResult = await verifyPassword(rawPassword.trim(), hash, pepperVersion, provider);
    expect(trimmedResult).toEqual({ valid: false, needsRehash: false });

    // Chuỗi tương đương NFKC phải xác minh khớp.
    const fullWidthResult = await verifyPassword(
      '  Mật Khẩu Rất Dài Và An Toàn ２０２６!  ',
      hash,
      pepperVersion,
      provider,
    );
    expect(fullWidthResult).toEqual({ valid: true, needsRehash: false });

    // Mật khẩu sai phải trả valid=false.
    const wrongResult = await verifyPassword('wrong-password-value', hash, pepperVersion, provider);
    expect(wrongResult).toEqual({ valid: false, needsRehash: false });
  });

  it('phát hiện needsRehash=true khi xoay CURRENT_PEPPER_VERSION từ v1 lên v2', async () => {
    const v1Provider = createMockPepperProvider(1, { 1: PEPPER_V1 });
    const v2Provider = createMockPepperProvider(2, { 1: PEPPER_V1, 2: PEPPER_V2 });
    const password = 'correct horse battery staple';

    const hashedWithV1 = await hashPassword(password, v1Provider);

    // Đăng nhập sau khi hệ thống nâng CURRENT_PEPPER_VERSION=2 nhưng vẫn giữ pepper v1 để verify hash cũ.
    const verifiedAfterRotation = await verifyPassword(
      password,
      hashedWithV1.hash,
      hashedWithV1.pepperVersion,
      v2Provider,
    );
    expect(verifiedAfterRotation).toEqual({ valid: true, needsRehash: true });

    // Nếu dùng sai pepperVersion để verify phải thất bại (chứng minh pepper thật sự tham gia HMAC).
    const wrongVersion = await verifyPassword(password, hashedWithV1.hash, 2, v2Provider);
    expect(wrongVersion).toEqual({ valid: false, needsRehash: false });

    // Sau khi rehash bằng v2, needsRehash phải quay về false.
    const rehashedWithV2 = await hashPassword(password, v2Provider);
    expect(rehashedWithV2.pepperVersion).toBe(2);
    const verifiedV2 = await verifyPassword(
      password,
      rehashedWithV2.hash,
      rehashedWithV2.pepperVersion,
      v2Provider,
    );
    expect(verifiedV2).toEqual({ valid: true, needsRehash: false });
  });

  it('phát hiện needsPasswordRehash=true khi tham số Argon2id trong PHC yếu hơn chính sách', async () => {
    const weakerMemoryHash = await rawArgon2Hash('synthetic-input', {
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    expect(needsPasswordRehash(weakerMemoryHash, 1, 1)).toBe(true);

    const weakerTimeHash = await rawArgon2Hash('synthetic-input', {
      memoryCost: 19456,
      timeCost: 1,
      parallelism: 1,
      outputLen: 32,
    });
    expect(needsPasswordRehash(weakerTimeHash, 1, 1)).toBe(true);

    const argon2iHash = await rawArgon2Hash('synthetic-input', {
      algorithm: 1,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    expect(needsPasswordRehash(argon2iHash, 1, 1)).toBe(true);

    // PHC hỏng cũng phải yêu cầu rehash.
    expect(needsPasswordRehash('not-a-valid-phc-hash', 1, 1)).toBe(true);
  });

  it('trả valid=false an toàn khi thiếu khóa pepper của phiên bản lưu trong DB hoặc PHC bị hỏng', async () => {
    const providerWithoutV99 = createMockPepperProvider(1, { 1: PEPPER_V1 });
    const missingPepper = await verifyPassword(
      'any-password-1234',
      '$argon2id$invalid',
      99,
      providerWithoutV99,
    );
    expect(missingPepper).toEqual({ valid: false, needsRehash: false });

    const malformedPhc = await verifyPassword(
      'any-password-1234',
      'corrupted-hash',
      1,
      providerWithoutV99,
    );
    expect(malformedPhc).toEqual({ valid: false, needsRehash: false });
  });

  it('verifyDummyPassword() chạy trọn vẹn 1 lượt Argon2id mà không ném lỗi', async () => {
    await expect(verifyDummyPassword()).resolves.toBeUndefined();
  });
});
