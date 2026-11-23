import { E2eeCryptoError, type E2eePublicJwk } from '@/lib/e2ee/types';

// Các ký tự điều khiển hướng văn bản nguy hiểm (Bidi / RTL Override U+202A..U+202E, U+2066..U+2069) và Null byte.
const DANGEROUS_TEXT_CONTROL_CHARS_REGEX = /[\u0000\u202A-\u202E\u2066-\u2069]/g;

export function getWebCrypto(): Crypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new E2eeCryptoError(
      'WEBCRYPTO_UNAVAILABLE',
      'Trình duyệt hiện tại không hỗ trợ giao thức bảo mật cần thiết.',
    );
  }
  return cryptoObj;
}

export function sanitizeChatPlaintext(input: string): string {
  return input.replace(DANGEROUS_TEXT_CONTROL_CHARS_REGEX, '');
}

export function utf8ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  const view = new Uint8Array(buffer);
  view.set(encoded);
  return view;
}

export function bytesToUtf8(bytes: BufferSource): string {
  return new TextDecoder().decode(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(base64url)) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Chuỗi dữ liệu mã hóa không đúng định dạng.');
  }
  const padded =
    base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);

  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(padded);
    const buffer = new ArrayBuffer(binary.length);
    const out = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  const nodeBuf = Buffer.from(padded, 'base64');
  const buffer = new ArrayBuffer(nodeBuf.byteLength);
  const out = new Uint8Array(buffer);
  out.set(nodeBuf);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const cryptoObj = getWebCrypto();
  const buffer = new ArrayBuffer(length);
  const view = new Uint8Array(buffer);
  cryptoObj.getRandomValues(view);
  return view;
}

export function normalizePublicP256Jwk(raw: JsonWebKey | E2eePublicJwk): E2eePublicJwk {
  if (
    raw.kty !== 'EC' ||
    raw.crv !== 'P-256' ||
    typeof raw.x !== 'string' ||
    typeof raw.y !== 'string' ||
    !raw.x ||
    !raw.y
  ) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Khóa công khai P-256 không hợp lệ.');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: raw.x,
    y: raw.y,
    ext: true,
  };
}

/**
 * Tính SHA-256 fingerprint 64 ký tự hex ràng buộc chặt chẽ cả khóa định danh ECDH P-256
 * và khóa chữ ký ECDSA P-256 của thiết bị. Công thức này được dùng thống nhất ở cả Client và Server.
 */
export async function computeDeviceKeyFingerprint(
  identityPublicKeyJwk: E2eePublicJwk,
  signingPublicKeyJwk: E2eePublicJwk,
): Promise<string> {
  const idJwk = normalizePublicP256Jwk(identityPublicKeyJwk);
  const sigJwk = normalizePublicP256Jwk(signingPublicKeyJwk);
  const canonical = `TOMATO-E2EE-P256-V1|EC|P-256|${idJwk.x}|${idJwk.y}|${sigJwk.x}|${sigJwk.y}`;
  const digest = await getWebCrypto().subtle.digest('SHA-256', utf8ToBytes(canonical));
  return bytesToHex(new Uint8Array(digest));
}
