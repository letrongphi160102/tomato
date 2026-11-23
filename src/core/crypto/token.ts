import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_SECURE_TOKEN_BYTES = 32;
const HEX_REGEX = /^[0-9a-f]+$/i;
const SHA256_HEX_LENGTH = 64;

/**
 * Sinh token ngẫu nhiên mật mã học tối thiểu 256-bit (32 bytes) ở dạng URL-safe base64url.
 * Dùng cho Refresh Token, Password Reset Token và CSRF Token.
 */
export function generateSecureToken(byteLength = MIN_SECURE_TOKEN_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < MIN_SECURE_TOKEN_BYTES) {
    throw new RangeError(
      `Độ dài token mật mã học phải là số nguyên tối thiểu ${MIN_SECURE_TOKEN_BYTES} bytes (256-bit)`,
    );
  }
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Băm SHA-256 ra chuỗi hex 64 ký tự (khớp cột CHAR(64) trong PostgreSQL).
 * Chỉ dùng cho token ngẫu nhiên entropy cao (>= 256-bit), KHÔNG dùng cho mật khẩu hay OTP ngắn.
 */
export function hashTokenSha256(token: string): string {
  if (token.length === 0) {
    throw new Error('Token không được rỗng khi băm SHA-256');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Băm SHA-256 có ràng buộc ngữ cảnh (domain separation) dùng ký tự phân cách NUL
 * để khóa cứng một token 256-bit vào đúng `(purpose, userId, sessionFamilyId)`,
 * ngăn tuyệt đối việc đánh cắp/tái dùng ticket sang user hoặc thiết bị khác.
 */
export function hashScopedTokenSha256(
  token: string,
  scope: { readonly purpose: string; readonly userId: string; readonly sessionFamilyId: string },
): string {
  if (token.length === 0) {
    throw new Error('Token không được rỗng khi băm SHA-256 theo ngữ cảnh');
  }
  return createHash('sha256')
    .update(
      `${scope.purpose}\u0000${scope.userId}\u0000${scope.sessionFamilyId}\u0000${token}`,
      'utf8',
    )
    .digest('hex');
}

/**
 * So sánh hằng thời gian cho hai chuỗi hex (chống timing side-channel).
 */
export function timingSafeEqualHex(leftHex: string, rightHex: string): boolean {
  if (
    leftHex.length === 0 ||
    leftHex.length !== rightHex.length ||
    leftHex.length % 2 !== 0 ||
    !HEX_REGEX.test(leftHex) ||
    !HEX_REGEX.test(rightHex)
  ) {
    return false;
  }

  const leftBuf = Buffer.from(leftHex.toLowerCase(), 'hex');
  const rightBuf = Buffer.from(rightHex.toLowerCase(), 'hex');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }

  return timingSafeEqual(leftBuf, rightBuf);
}

/**
 * So sánh hằng thời gian cho hai chuỗi UTF-8 (ví dụ Double-Submit CSRF Token).
 */
export function timingSafeEqualUtf8(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

/**
 * Xác minh opaque token với bản băm SHA-256 hex lưu trong DB bằng so sánh hằng thời gian.
 */
export function verifyTokenHash(token: string, expectedHashHex: string): boolean {
  if (token.length === 0 || expectedHashHex.length !== SHA256_HEX_LENGTH) {
    return false;
  }
  const computedHex = hashTokenSha256(token);
  return timingSafeEqualHex(computedHex, expectedHashHex);
}
