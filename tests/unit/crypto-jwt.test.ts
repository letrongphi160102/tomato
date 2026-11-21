import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenVerificationError,
  signAccessToken,
  verifyAccessToken,
} from '@/core/crypto/jwt';

const JWT_SECRET_A = 'unit-test-only-jwt-secret-a-at-least-32-characters';
const JWT_SECRET_B = 'unit-test-only-jwt-secret-b-at-least-32-characters';

describe('JWT Access Token (jose HS256)', () => {
  it('ký và xác minh Access Token với hạn 15 phút và payload tối giản chỉ gồm sub, sid, iat, exp', async () => {
    const nowSeconds = 1_760_000_000;
    const userPublicId = '4a2e62d7-92db-442e-85e4-c9377211641a';
    const sessionPublicId = 'd8d5e453-5a15-43f7-9cb6-46ce45582e7e';

    const token = await signAccessToken(
      { userPublicId, sessionPublicId },
      { secret: JWT_SECRET_A, nowSeconds },
    );

    const protectedHeader = decodeProtectedHeader(token);
    expect(protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT' });

    const rawPayload = decodeJwt(token);
    expect(Object.keys(rawPayload).sort()).toEqual(['exp', 'iat', 'sid', 'sub']);

    const verified = await verifyAccessToken(token, {
      secret: JWT_SECRET_A,
      currentDate: new Date((nowSeconds + 60) * 1000),
    });

    expect(verified).toEqual({
      sub: userPublicId,
      sid: sessionPublicId,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    });
    expect(verified.exp - verified.iat).toBe(900);
  });

  it('từ chối token đã hết hạn với reason="expired"', async () => {
    const nowSeconds = 1_760_000_000;
    const token = await signAccessToken(
      {
        userPublicId: '4a2e62d7-92db-442e-85e4-c9377211641a',
        sessionPublicId: 'd8d5e453-5a15-43f7-9cb6-46ce45582e7e',
      },
      { secret: JWT_SECRET_A, nowSeconds },
    );

    await expect(
      verifyAccessToken(token, {
        secret: JWT_SECRET_A,
        currentDate: new Date((nowSeconds + ACCESS_TOKEN_TTL_SECONDS + 1) * 1000),
      }),
    ).rejects.toMatchObject({
      name: 'AccessTokenVerificationError',
      reason: 'expired',
    });
  });

  it('từ chối token sai khóa, bị chỉnh sửa payload hoặc sai thuật toán (HS384 / alg:none)', async () => {
    const nowSeconds = 1_760_000_000;
    const token = await signAccessToken(
      {
        userPublicId: '4a2e62d7-92db-442e-85e4-c9377211641a',
        sessionPublicId: 'd8d5e453-5a15-43f7-9cb6-46ce45582e7e',
      },
      { secret: JWT_SECRET_A, nowSeconds },
    );

    // Sai secret
    await expect(
      verifyAccessToken(token, {
        secret: JWT_SECRET_B,
        currentDate: new Date((nowSeconds + 10) * 1000),
      }),
    ).rejects.toBeInstanceOf(AccessTokenVerificationError);

    // Chỉnh sửa payload giữ nguyên chữ ký
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: 'attacker-id',
        sid: 'fake-sid',
        iat: nowSeconds,
        exp: nowSeconds + 900,
      }),
    ).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    await expect(
      verifyAccessToken(tamperedToken, {
        secret: JWT_SECRET_A,
        currentDate: new Date((nowSeconds + 10) * 1000),
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });

    // Token ký bằng thuật toán HS384 phải bị chặn bởi algorithm pinning (chỉ chấp nhận HS256).
    const hs384Token = await new SignJWT({ sid: 'd8d5e453-5a15-43f7-9cb6-46ce45582e7e' })
      .setProtectedHeader({ alg: 'HS384', typ: 'JWT' })
      .setSubject('4a2e62d7-92db-442e-85e4-c9377211641a')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 900)
      .sign(new TextEncoder().encode(JWT_SECRET_A));

    await expect(
      verifyAccessToken(hs384Token, {
        secret: JWT_SECRET_A,
        currentDate: new Date((nowSeconds + 10) * 1000),
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });

    // Token alg: none giả mạo không chữ ký phải bị chặn.
    const algNoneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const unsignedToken = `${algNoneHeader}.${parts[1]}.`;
    await expect(
      verifyAccessToken(unsignedToken, {
        secret: JWT_SECRET_A,
        currentDate: new Date((nowSeconds + 10) * 1000),
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });
});
