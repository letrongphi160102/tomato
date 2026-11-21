import 'server-only';

import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

import { getEnv } from '@/core/config/env';

export const ACCESS_TOKEN_ALGORITHM = 'HS256' as const;
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const MIN_JWT_SECRET_LENGTH = 32;

export interface AccessTokenSignInput {
  readonly userPublicId: string;
  readonly sessionPublicId: string;
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
}

export interface SignAccessTokenOptions {
  readonly secret?: string;
  readonly expiresInSeconds?: number;
  readonly nowSeconds?: number;
}

export interface VerifyAccessTokenOptions {
  readonly secret?: string;
  readonly currentDate?: Date;
}

export type AccessTokenErrorReason = 'expired' | 'invalid';

export class AccessTokenVerificationError extends Error {
  public readonly reason: AccessTokenErrorReason;

  constructor(reason: AccessTokenErrorReason, message: string) {
    super(message);
    this.name = 'AccessTokenVerificationError';
    this.reason = reason;
  }
}

function resolveJwtSecretKey(secretOverride?: string): Uint8Array {
  const secret = secretOverride ?? getEnv().JWT_SECRET;
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET phải có tối thiểu ${MIN_JWT_SECRET_LENGTH} ký tự (256-bit)`);
  }
  return new TextEncoder().encode(secret);
}

/**
 * Ký Access Token JWT (HS256, mặc định hạn 15 phút).
 * Payload tối giản chỉ chứa `sub` (`user.public_id`) và `sid` (`session.public_id`),
 * tuyệt đối không đặt `id` nội bộ (UUIDv7) hay dữ liệu cá nhân nhạy cảm vào JWT.
 */
export async function signAccessToken(
  input: AccessTokenSignInput,
  options: SignAccessTokenOptions = {},
): Promise<string> {
  if (!input.userPublicId.trim() || !input.sessionPublicId.trim()) {
    throw new Error('userPublicId và sessionPublicId là bắt buộc khi ký Access Token');
  }

  const ttlSeconds = options.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('expiresInSeconds phải là số nguyên dương');
  }

  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const secretKey = resolveJwtSecretKey(options.secret);

  return new SignJWT({ sid: input.sessionPublicId })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(input.userPublicId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(secretKey);
}

/**
 * Xác minh Access Token JWT với algorithm pinning (`HS256`) để chống tấn công
 * algorithm confusion (`alg: none` hoặc giả mạo khóa công khai).
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions = {},
): Promise<AccessTokenClaims> {
  if (!token || token.trim().length === 0) {
    throw new AccessTokenVerificationError('invalid', 'Access Token rỗng hoặc không hợp lệ');
  }

  const secretKey = resolveJwtSecretKey(options.secret);

  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      typ: 'JWT',
      currentDate: options.currentDate,
    });

    const sub = payload.sub;
    const sid = payload.sid;
    const iat = payload.iat;
    const exp = payload.exp;

    if (
      typeof sub !== 'string' ||
      sub.trim().length === 0 ||
      typeof sid !== 'string' ||
      sid.trim().length === 0 ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      throw new AccessTokenVerificationError(
        'invalid',
        'Payload Access Token thiếu trường bắt buộc (sub/sid/iat/exp)',
      );
    }

    return { sub, sid, iat, exp };
  } catch (error) {
    if (error instanceof AccessTokenVerificationError) {
      throw error;
    }
    if (error instanceof joseErrors.JWTExpired) {
      throw new AccessTokenVerificationError('expired', 'Access Token đã hết hạn');
    }
    throw new AccessTokenVerificationError('invalid', 'Access Token không hợp lệ');
  }
}
