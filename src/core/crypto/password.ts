import 'server-only';

import {
  hash as argon2Hash,
  parseOptions as argon2ParseOptions,
  verify as argon2Verify,
  type Algorithm,
  type Options as Argon2Options,
  type Version,
} from '@node-rs/argon2';
import { createHmac } from 'node:crypto';

import { getEnv } from '@/core/config/env';
import { normalizePassword } from '@/core/crypto/normalize';

// Dùng giá trị số tường minh khớp với `const enum Algorithm/Version` của `@node-rs/argon2`
// để tương thích tuyệt đối với `isolatedModules: true` của TypeScript và bundler Next.js.
const ARGON2ID_ALGORITHM = 2 as Algorithm;
const ARGON2_VERSION_19 = 1 as Version;

/**
 * Tham số Argon2id chuẩn OWASP theo Mục 6.1:
 * - memoryCost = 19456 KiB (19 MiB)
 * - timeCost = 2 lượt
 * - parallelism = 1 luồng
 * - outputLen = 32 bytes (hashLength = 32)
 * - salt ngẫu nhiên 16 bytes (mặc định CSPRNG của @node-rs/argon2)
 */
export const PASSWORD_HASH_POLICY = Object.freeze({
  algorithm: ARGON2ID_ALGORITHM,
  version: ARGON2_VERSION_19,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  minSaltLen: 16,
});

// Chuỗi PHC Argon2id giả hợp lệ được tạo sẵn với đúng tham số m=19456,t=2,p=1 (32-byte digest)
// để `verifyDummyPassword()` luôn chạy đúng 1 lượt verify thật (không mất 2x thời gian ở cold start).
const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$W+lgLFNQvU11yYvb7bsSMw$/7EVqGio701sOrIEF4AqC+M2yV3EzWt0GzL5Xmjov1A';
const DUMMY_MISMATCH_INPUT = 'tomato-non-matching-dummy-verification-probe';

/**
 * Port trừu tượng lấy khóa Pepper (Mục 1.1) giúp dễ dàng thay Env Var bằng KMS khi mở rộng.
 */
export interface PepperSecretProvider {
  getCurrentVersion(): number;
  getPepper(version: number): string | undefined;
}

export class EnvPepperSecretProvider implements PepperSecretProvider {
  getCurrentVersion(): number {
    return getEnv().CURRENT_PEPPER_VERSION;
  }

  getPepper(version: number): string | undefined {
    return getEnv().PASSWORD_PEPPER_SECRETS[version];
  }
}

const defaultPepperProvider: PepperSecretProvider = new EnvPepperSecretProvider();

export interface HashedPasswordResult {
  readonly hash: string;
  readonly pepperVersion: number;
}

export interface PasswordVerificationResult {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

function computePepperedInput(rawPassword: string, pepperSecret: string): string {
  const normalized = normalizePassword(rawPassword);
  // Dùng digest hex (64 ký tự ASCII) để tránh mọi rủi ro NUL-byte truncation ở tầng native.
  return createHmac('sha256', pepperSecret).update(normalized, 'utf8').digest('hex');
}

function buildArgon2Options(): Argon2Options {
  return {
    algorithm: PASSWORD_HASH_POLICY.algorithm,
    version: PASSWORD_HASH_POLICY.version,
    memoryCost: PASSWORD_HASH_POLICY.memoryCost,
    timeCost: PASSWORD_HASH_POLICY.timeCost,
    parallelism: PASSWORD_HASH_POLICY.parallelism,
    outputLen: PASSWORD_HASH_POLICY.outputLen,
  };
}

/**
 * Băm mật khẩu theo chuẩn 2 lớp: NFKC (không trim) -> HMAC-SHA256(pepper[version]) -> Argon2id.
 */
export async function hashPassword(
  rawPassword: string,
  provider: PepperSecretProvider = defaultPepperProvider,
): Promise<HashedPasswordResult> {
  if (rawPassword.length === 0) {
    throw new Error('Mật khẩu không được rỗng khi băm');
  }

  const pepperVersion = provider.getCurrentVersion();
  const pepperSecret = provider.getPepper(pepperVersion);
  if (!pepperSecret) {
    throw new Error(`Không tìm thấy khóa Pepper cho phiên bản ${pepperVersion}`);
  }

  const peppered = computePepperedInput(rawPassword, pepperSecret);
  const hash = await argon2Hash(peppered, buildArgon2Options());

  return { hash, pepperVersion };
}

/**
 * Kiểm tra xem bản băm hiện có có cần băm lại (rehash) sau khi đăng nhập thành công hay không:
 * - Phiên bản Pepper cũ hơn `CURRENT_PEPPER_VERSION` (key rotation).
 * - Tham số Argon2id trong chuỗi PHC yếu hơn chính sách hiện tại (`m`, `t`, `p`, `outputLen`, `saltLen`, `algorithm`, `version`).
 */
export function needsPasswordRehash(
  phcHash: string,
  storedPepperVersion: number,
  currentPepperVersion: number = defaultPepperProvider.getCurrentVersion(),
): boolean {
  if (storedPepperVersion !== currentPepperVersion) {
    return true;
  }

  try {
    const parsed = argon2ParseOptions(phcHash);
    return (
      parsed.algorithm !== PASSWORD_HASH_POLICY.algorithm ||
      parsed.version !== PASSWORD_HASH_POLICY.version ||
      parsed.memoryCost < PASSWORD_HASH_POLICY.memoryCost ||
      parsed.timeCost < PASSWORD_HASH_POLICY.timeCost ||
      parsed.parallelism !== PASSWORD_HASH_POLICY.parallelism ||
      parsed.outputLen < PASSWORD_HASH_POLICY.outputLen ||
      parsed.saltLen < PASSWORD_HASH_POLICY.minSaltLen
    );
  } catch {
    return true;
  }
}

/**
 * Xác minh mật khẩu người dùng đối chiếu bản băm Argon2id + Pepper lưu trong DB.
 * Trả về cả cờ `needsRehash` để tầng Auth tự động nâng cấp hash trong suốt khi đăng nhập thành công.
 */
export async function verifyPassword(
  rawPassword: string,
  storedHash: string,
  storedPepperVersion: number,
  provider: PepperSecretProvider = defaultPepperProvider,
): Promise<PasswordVerificationResult> {
  if (rawPassword.length === 0 || storedHash.length === 0) {
    return { valid: false, needsRehash: false };
  }

  const pepperSecret = provider.getPepper(storedPepperVersion);
  if (!pepperSecret) {
    return { valid: false, needsRehash: false };
  }

  const peppered = computePepperedInput(rawPassword, pepperSecret);

  let valid = false;
  try {
    valid = await argon2Verify(storedHash, peppered);
  } catch {
    return { valid: false, needsRehash: false };
  }

  if (!valid) {
    return { valid: false, needsRehash: false };
  }

  const needsRehash = needsPasswordRehash(
    storedHash,
    storedPepperVersion,
    provider.getCurrentVersion(),
  );

  return { valid: true, needsRehash };
}

/**
 * Chạy 1 lượt xác minh Argon2id giả có cùng chi phí bộ nhớ/CPU (`m=19456,t=2,p=1`)
 * khi email không tồn tại nhằm triệt tiêu Timing Attack / User Enumeration.
 */
export async function verifyDummyPassword(): Promise<void> {
  await argon2Verify(DUMMY_ARGON2ID_HASH, DUMMY_MISMATCH_INPUT);
}
