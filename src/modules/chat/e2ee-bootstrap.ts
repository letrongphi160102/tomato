import 'server-only';

import { createECDH, hkdfSync } from 'node:crypto';

import { getEnv } from '@/core/config/env';
import type { E2eePublicJwkRecord } from '@/core/db/schema';
import type { E2eePrivateJwk } from '@/lib/e2ee/types';
import { computeDeviceKeyFingerprint } from '@/lib/e2ee/utils';

// Bậc (order) n của đường cong NIST P-256 (secp256r1 / prime256v1).
const P256_CURVE_ORDER = BigInt(
  '0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551',
);
const P256_CURVE_ORDER_MINUS_ONE = P256_CURVE_ORDER - BigInt(1);

export interface UserBootstrapKeyPairBundle {
  readonly keyFingerprint: string;
  readonly identityPublicKeyJwk: E2eePublicJwkRecord;
  readonly identityPrivateJwk: E2eePrivateJwk;
  readonly signingPublicKeyJwk: E2eePublicJwkRecord;
  readonly signingPrivateJwk: E2eePrivateJwk;
}

function deriveP256KeyPairFromSeed(
  masterSecret: string,
  userId: string,
  purpose: 'identity' | 'signing',
): {
  readonly publicJwk: E2eePublicJwkRecord;
  readonly privateJwk: E2eePrivateJwk;
} {
  const rawBytes = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterSecret, 'utf8'),
      Buffer.from(userId, 'utf8'),
      Buffer.from(`tomato-e2ee-bootstrap-v1|${purpose}`, 'utf8'),
      32,
    ),
  );

  // Ánh xạ 256-bit seed vào khoảng hợp lệ [1, n - 1] của đường cong P-256.
  const rawBigInt = BigInt(`0x${rawBytes.toString('hex')}`);
  const scalarBigInt = (rawBigInt % P256_CURVE_ORDER_MINUS_ONE) + BigInt(1);
  const scalarHex = scalarBigInt.toString(16).padStart(64, '0');
  const dBuffer = Buffer.from(scalarHex, 'hex');

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(dBuffer);
  // Định dạng uncompressed point: 0x04 || X (32 bytes) || Y (32 bytes).
  const uncompressedPub = ecdh.getPublicKey();
  const xBuffer = uncompressedPub.subarray(1, 33);
  const yBuffer = uncompressedPub.subarray(33, 65);

  const x = xBuffer.toString('base64url');
  const y = yBuffer.toString('base64url');
  const d = dBuffer.toString('base64url');

  const publicJwk: E2eePublicJwkRecord = {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    ext: true,
  };

  const privateJwk: E2eePrivateJwk = {
    ...publicJwk,
    d,
  };

  return { publicJwk, privateJwk };
}

/**
 * Sinh cặp khóa P-256 khởi tạo mặc định (Pre-Key Bootstrap) cho tài khoản chưa kịp mở trình duyệt
 * sau khi hệ thống nâng cấp tính năng nhắn tin:
 * - Giúp người gửi luôn có khóa công khai P-256 hợp lệ để mã hóa tin nhắn ngay cả khi người nhận đang ngoại tuyến.
 * - Khi người nhận đăng nhập vào trình duyệt, khóa riêng này được nạp tự động vào IndexedDB ở chế độ `extractable: false`.
 */
export async function deriveUserBootstrapKeyPairBundle(
  userId: string,
): Promise<UserBootstrapKeyPairBundle> {
  const masterSecret = getEnv().JWT_SECRET;
  const identity = deriveP256KeyPairFromSeed(masterSecret, userId, 'identity');
  const signing = deriveP256KeyPairFromSeed(masterSecret, userId, 'signing');

  const keyFingerprint = await computeDeviceKeyFingerprint(identity.publicJwk, signing.publicJwk);

  return {
    keyFingerprint,
    identityPublicKeyJwk: identity.publicJwk,
    identityPrivateJwk: identity.privateJwk,
    signingPublicKeyJwk: signing.publicJwk,
    signingPrivateJwk: signing.privateJwk,
  };
}
