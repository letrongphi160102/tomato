import 'server-only';

import { createHmac, randomInt } from 'node:crypto';

import { getEnv } from '@/core/config/env';
import { timingSafeEqualHex } from '@/core/crypto/token';
import type { VerificationTokenPurpose } from '@/core/db/schema/enums';

export const OTP_LENGTH = 6;
const OTP_DIGITS_REGEX = /^\d{6}$/;
const HMAC_SHA256_HEX_LENGTH = 64;
const MIN_OTP_SECRET_LENGTH = 32;

export interface OtpHashContext {
  readonly userId: string;
  readonly purpose: VerificationTokenPurpose;
}

export interface ScopedOtpHashContext {
  readonly userId: string;
  readonly scope: 'e2ee_pin_reset';
}

/**
 * Sinh mã OTP 6 chữ số phân bố đều bằng CSPRNG (`crypto.randomInt`),
 * tránh hoàn toàn lỗi lệch phân bố (modulo bias).
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
}

function resolveOtpSecret(secretOverride?: string): string {
  const secret = secretOverride ?? getEnv().OTP_SECRET;
  if (secret.length < MIN_OTP_SECRET_LENGTH) {
    throw new Error(`OTP_SECRET phải có tối thiểu ${MIN_OTP_SECRET_LENGTH} ký tự`);
  }
  return secret;
}

/**
 * Băm OTP bằng HMAC-SHA256 với `OTP_SECRET` và ràng buộc ngữ cảnh `(purpose, userId)`.
 * Tách biệt miền (domain separation) ngăn việc hash OTP bị đối chiếu chéo giữa 2 user
 * hoặc bị lạm dụng từ mục đích `email_verify` sang `password_change`.
 */
export function hashOtpCode(otp: string, context: OtpHashContext, secretOverride?: string): string {
  if (!OTP_DIGITS_REGEX.test(otp)) {
    throw new Error('Mã OTP phải gồm đúng 6 chữ số');
  }
  if (!context.userId.trim()) {
    throw new Error('Ngữ cảnh băm OTP bắt buộc có userId hợp lệ');
  }

  const secret = resolveOtpSecret(secretOverride);
  const message = `${context.purpose}:${context.userId}:${otp}`;
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/**
 * Xác minh OTP 6 chữ số với bản băm HMAC-SHA256 lưu trong DB bằng so sánh hằng thời gian.
 */
export function verifyOtpCode(
  otp: string,
  expectedHashHex: string,
  context: OtpHashContext,
  secretOverride?: string,
): boolean {
  if (
    !OTP_DIGITS_REGEX.test(otp) ||
    expectedHashHex.length !== HMAC_SHA256_HEX_LENGTH ||
    !context.userId.trim()
  ) {
    return false;
  }

  const computedHash = hashOtpCode(otp, context, secretOverride);
  return timingSafeEqualHex(computedHash, expectedHashHex);
}

/**
 * Băm OTP 6 chữ số theo miền nghiệp vụ riêng biệt (ví dụ `e2ee_pin_reset`) dùng chung `OTP_SECRET`
 * để lưu bản băm HMAC-SHA256 an toàn trong Redis (tuyệt đối không lưu OTP dạng rõ).
 */
export function hashScopedOtpCode(
  otp: string,
  context: ScopedOtpHashContext,
  secretOverride?: string,
): string {
  if (!OTP_DIGITS_REGEX.test(otp)) {
    throw new Error('Mã OTP phải gồm đúng 6 chữ số');
  }
  if (!context.userId.trim()) {
    throw new Error('Ngữ cảnh băm OTP bắt buộc có userId hợp lệ');
  }

  const secret = resolveOtpSecret(secretOverride);
  const message = `${context.scope}:${context.userId}:${otp}`;
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export function verifyScopedOtpCode(
  otp: string,
  expectedHashHex: string,
  context: ScopedOtpHashContext,
  secretOverride?: string,
): boolean {
  if (
    !OTP_DIGITS_REGEX.test(otp) ||
    expectedHashHex.length !== HMAC_SHA256_HEX_LENGTH ||
    !context.userId.trim()
  ) {
    return false;
  }

  const computedHash = hashScopedOtpCode(otp, context, secretOverride);
  return timingSafeEqualHex(computedHash, expectedHashHex);
}

/**
 * Che một phần địa chỉ email để hiển thị thân thiện trên giao diện (ví dụ `l***@gmail.com`).
 */
export function maskEmailAddress(rawEmail: string): string {
  const trimmed = rawEmail.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return '***';
  }

  const localPart = trimmed.slice(0, atIndex);
  const domainPart = trimmed.slice(atIndex + 1);
  const visiblePrefix = localPart.slice(0, 1);
  return `${visiblePrefix}***@${domainPart}`;
}
