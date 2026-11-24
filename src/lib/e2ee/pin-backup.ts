import { saveDeviceKeyMaterial } from '@/lib/e2ee/keystore';
import {
  E2eeCryptoError,
  type E2eeDeviceKeyPairMaterial,
  type E2eePrivateJwk,
  type E2eePublicJwk,
} from '@/lib/e2ee/types';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  computeDeviceKeyFingerprint,
  getWebCrypto,
  normalizePublicP256Jwk,
  randomBytes,
  utf8ToBytes,
} from '@/lib/e2ee/utils';

export const MIN_PIN_PBKDF2_ITERATIONS = 600_000;
const PIN_REGEX = /^\d{6}$/;

export interface EncryptedKeyBackupBundleDto {
  readonly encryptedKeyBlob: string;
  readonly kdfSalt: string;
  readonly kdfParams: {
    readonly alg: 'PBKDF2-SHA256';
    readonly iterations: number;
  };
  readonly iv: string;
  readonly keyFingerprint: string;
  readonly version: number;
}

export interface CreatePinBackupResult {
  readonly backup: EncryptedKeyBackupBundleDto;
  readonly publicRegistration: {
    readonly identityPublicKeyJwk: E2eePublicJwk;
    readonly signingPublicKeyJwk: E2eePublicJwk;
    readonly keyFingerprint: string;
    readonly deviceLabel: string;
  };
  readonly localMaterial: E2eeDeviceKeyPairMaterial;
}

interface SerializedBackupKeyCleartext {
  readonly v: 1;
  readonly keyFingerprint: string;
  readonly identityPrivateJwk: E2eePrivateJwk;
  readonly identityPublicJwk: E2eePublicJwk;
  readonly signingPrivateJwk: E2eePrivateJwk;
  readonly signingPublicJwk: E2eePublicJwk;
}

function assertValidSixDigitPin(pin: string): void {
  if (!PIN_REGEX.test(pin)) {
    throw new E2eeCryptoError('INVALID_PIN_FORMAT', 'Mã PIN bảo vệ phải gồm đúng 6 chữ số.');
  }
}

function buildBackupAad(userPublicId: string, keyFingerprint: string): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(`tomato-pin-backup-v1|${userPublicId.toLowerCase()}|${keyFingerprint}`);
}

async function derivePinAesKey(
  pin: string,
  saltBytes: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;
  const baseKey = await subtle.importKey('raw', utf8ToBytes(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Tạo bản sao lưu khóa mã hóa bằng Mã PIN 6 chữ số:
 * 1. Sinh cặp khóa sao lưu trong RAM với `extractable: true` chỉ trong khoảnh khắc đóng gói.
 * 2. Xuất JWK, mã hóa bằng `PBKDF2-SHA256` (600.000 vòng) + `AES-256-GCM` kèm AAD `userPublicId|keyFingerprint`.
 * 3. Lập tức import lại vào IndexedDB với `extractable: false` và xóa sạch khóa riêng JWK khỏi RAM.
 */
export async function createPinProtectedKeyBackup(params: {
  readonly userPublicId: string;
  readonly pin: string;
  readonly iterations?: number;
  /** Mặc định `true`. Truyền `false` khi muốn chờ Server xác nhận (ví dụ Quên PIN) rồi mới ghi đè slot `backup` trong IndexedDB. */
  readonly persistLocally?: boolean;
}): Promise<CreatePinBackupResult> {
  assertValidSixDigitPin(params.pin);
  const iterations = params.iterations ?? MIN_PIN_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_PIN_PBKDF2_ITERATIONS) {
    throw new E2eeCryptoError(
      'INVALID_KEY_FORMAT',
      `Số vòng lặp PBKDF2 phải tối thiểu ${MIN_PIN_PBKDF2_ITERATIONS}.`,
    );
  }

  const cryptoObj = getWebCrypto();
  const subtle = cryptoObj.subtle;

  // Bước 1: Sinh cặp khóa sao lưu tạm trong RAM với extractable: true để xuất JWK mã hóa.
  const [tempIdentityPair, tempSigningPair] = await Promise.all([
    subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ]);

  const [rawIdPriv, rawIdPub, rawSigPriv, rawSigPub] = await Promise.all([
    subtle.exportKey('jwk', tempIdentityPair.privateKey) as Promise<E2eePrivateJwk>,
    subtle.exportKey('jwk', tempIdentityPair.publicKey),
    subtle.exportKey('jwk', tempSigningPair.privateKey) as Promise<E2eePrivateJwk>,
    subtle.exportKey('jwk', tempSigningPair.publicKey),
  ]);

  const identityPublicJwk = normalizePublicP256Jwk(rawIdPub);
  const signingPublicJwk = normalizePublicP256Jwk(rawSigPub);
  const keyFingerprint = await computeDeviceKeyFingerprint(identityPublicJwk, signingPublicJwk);

  const cleartextBundle: SerializedBackupKeyCleartext = {
    v: 1,
    keyFingerprint,
    identityPrivateJwk: {
      ...identityPublicJwk,
      d: rawIdPriv.d,
    },
    identityPublicJwk,
    signingPrivateJwk: {
      ...signingPublicJwk,
      d: rawSigPriv.d,
    },
    signingPublicJwk,
  };

  // Bước 2: Mã hóa bằng PBKDF2-SHA256 + AES-256-GCM.
  const saltBytes = randomBytes(16);
  const ivBytes = randomBytes(12);
  const pinAesKey = await derivePinAesKey(params.pin, saltBytes, iterations);
  const aadBytes = buildBackupAad(params.userPublicId, keyFingerprint);

  const plaintextBytes = utf8ToBytes(JSON.stringify(cleartextBundle));
  const encryptedBuf = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aadBytes,
      tagLength: 128,
    },
    pinAesKey,
    plaintextBytes,
  );
  plaintextBytes.fill(0);

  // Bước 3: Lập tức import lại khóa riêng với `extractable: false` và lưu vào IndexedDB.
  const [nonExtractableIdentityPriv, nonExtractableSigningPriv] = await Promise.all([
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: identityPublicJwk.x,
        y: identityPublicJwk.y,
        d: rawIdPriv.d,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // extractable: false
      ['deriveBits'],
    ),
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: signingPublicJwk.x,
        y: signingPublicJwk.y,
        d: rawSigPriv.d,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // extractable: false
      ['sign'],
    ),
  ]);

  // Bước 4: Xóa sạch thành phần khóa bí mật `d` khỏi các object JWK trong RAM.
  rawIdPriv.d = '';
  rawSigPriv.d = '';
  cleartextBundle.identityPrivateJwk.d = '';
  cleartextBundle.signingPrivateJwk.d = '';

  const localMaterial: E2eeDeviceKeyPairMaterial = {
    userPublicId: params.userPublicId,
    devicePublicId: cryptoObj.randomUUID(),
    keyFingerprint,
    identityPrivateKey: nonExtractableIdentityPriv,
    identityPublicKeyJwk: identityPublicJwk,
    signingPrivateKey: nonExtractableSigningPriv,
    signingPublicKeyJwk: signingPublicJwk,
    createdAtIso: new Date().toISOString(),
    isBackupKey: true,
  };

  if (params.persistLocally !== false) {
    await saveDeviceKeyMaterial(localMaterial, 'backup');
  }

  return {
    backup: {
      encryptedKeyBlob: bytesToBase64Url(new Uint8Array(encryptedBuf)),
      kdfSalt: bytesToBase64Url(saltBytes),
      kdfParams: {
        alg: 'PBKDF2-SHA256',
        iterations,
      },
      iv: bytesToBase64Url(ivBytes),
      keyFingerprint,
      version: 1,
    },
    publicRegistration: {
      identityPublicKeyJwk: identityPublicJwk,
      signingPublicKeyJwk: signingPublicJwk,
      keyFingerprint,
      deviceLabel: 'Khóa đồng bộ tin nhắn',
    },
    localMaterial,
  };
}

/**
 * Giải mã bản sao lưu bằng Mã PIN 6 chữ số trên thiết bị mới và nạp thẳng vào IndexedDB
 * dưới dạng `CryptoKey` với `extractable: false`.
 */
export async function restorePinProtectedKeyBackup(params: {
  readonly userPublicId: string;
  readonly pin: string;
  readonly backup: EncryptedKeyBackupBundleDto;
  readonly devicePublicId?: string;
}): Promise<E2eeDeviceKeyPairMaterial> {
  assertValidSixDigitPin(params.pin);

  if (
    params.backup.kdfParams.alg !== 'PBKDF2-SHA256' ||
    !Number.isInteger(params.backup.kdfParams.iterations) ||
    params.backup.kdfParams.iterations < MIN_PIN_PBKDF2_ITERATIONS
  ) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Thông số bảo vệ bản sao lưu không hợp lệ.');
  }

  const cryptoObj = getWebCrypto();
  const subtle = cryptoObj.subtle;
  const saltBytes = base64UrlToBytes(params.backup.kdfSalt);
  const ivBytes = base64UrlToBytes(params.backup.iv);
  const aadBytes = buildBackupAad(params.userPublicId, params.backup.keyFingerprint);

  const pinAesKey = await derivePinAesKey(
    params.pin,
    saltBytes,
    params.backup.kdfParams.iterations,
  );

  let decryptedBytes: Uint8Array<ArrayBuffer>;
  try {
    const buf = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: aadBytes,
        tagLength: 128,
      },
      pinAesKey,
      base64UrlToBytes(params.backup.encryptedKeyBlob),
    );
    decryptedBytes = new Uint8Array(buf);
  } catch {
    throw new E2eeCryptoError(
      'BACKUP_DECRYPT_FAILED',
      'Mã PIN không chính xác hoặc bản sao lưu không khớp.',
    );
  }

  let parsed: SerializedBackupKeyCleartext;
  try {
    parsed = JSON.parse(bytesToUtf8(decryptedBytes)) as SerializedBackupKeyCleartext;
  } finally {
    decryptedBytes.fill(0);
  }

  const identityPublicJwk = normalizePublicP256Jwk(parsed.identityPublicJwk);
  const signingPublicJwk = normalizePublicP256Jwk(parsed.signingPublicJwk);
  const computedFingerprint = await computeDeviceKeyFingerprint(
    identityPublicJwk,
    signingPublicJwk,
  );

  if (computedFingerprint !== params.backup.keyFingerprint) {
    parsed.identityPrivateJwk.d = '';
    parsed.signingPrivateJwk.d = '';
    throw new E2eeCryptoError(
      'BACKUP_DECRYPT_FAILED',
      'Dữ liệu khóa trong bản sao lưu không toàn vẹn.',
    );
  }

  const [nonExtractableIdentityPriv, nonExtractableSigningPriv] = await Promise.all([
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: identityPublicJwk.x,
        y: identityPublicJwk.y,
        d: parsed.identityPrivateJwk.d,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // extractable: false
      ['deriveBits'],
    ),
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: signingPublicJwk.x,
        y: signingPublicJwk.y,
        d: parsed.signingPrivateJwk.d,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // extractable: false
      ['sign'],
    ),
  ]);

  parsed.identityPrivateJwk.d = '';
  parsed.signingPrivateJwk.d = '';

  const material: E2eeDeviceKeyPairMaterial = {
    userPublicId: params.userPublicId,
    devicePublicId: params.devicePublicId ?? cryptoObj.randomUUID(),
    keyFingerprint: computedFingerprint,
    identityPrivateKey: nonExtractableIdentityPriv,
    identityPublicKeyJwk: identityPublicJwk,
    signingPrivateKey: nonExtractableSigningPriv,
    signingPublicKeyJwk: signingPublicJwk,
    createdAtIso: new Date().toISOString(),
    isBackupKey: true,
  };

  await saveDeviceKeyMaterial(material, 'backup');
  return material;
}

/**
 * Đổi mã PIN 6 chữ số KHÔNG cần email và KHÔNG mất bất kỳ tin nhắn nào:
 * 1. Giải mã bản sao lưu hiện tại trong RAM bằng `currentPin` (xác thực PIN cũ qua thẻ xác thực AES-GCM).
 * 2. GIỮ NGUYÊN cặp khóa đồng bộ gốc (`keyFingerprint`, khóa riêng ECDH & ECDSA gốc).
 * 3. Sinh `kdfSalt` mới (16 bytes) + `iv` mới (12 bytes), mã hóa lại bằng `PBKDF2-SHA256` (>= 600.000 vòng) + `AES-256-GCM` từ `newPin`.
 * 4. Xóa sạch toàn bộ thành phần khóa bí mật JWK `d` và buffer plaintext khỏi RAM ngay lập tức.
 */
export async function reEncryptPinProtectedKeyBackup(params: {
  readonly userPublicId: string;
  readonly currentPin: string;
  readonly newPin: string;
  readonly backup: EncryptedKeyBackupBundleDto;
  readonly iterations?: number;
  readonly persistLocally?: boolean;
}): Promise<CreatePinBackupResult> {
  assertValidSixDigitPin(params.currentPin);
  assertValidSixDigitPin(params.newPin);

  if (params.currentPin === params.newPin) {
    throw new E2eeCryptoError('INVALID_PIN_FORMAT', 'Mã PIN mới phải khác mã PIN hiện tại.');
  }

  const iterations =
    params.iterations ?? Math.max(params.backup.kdfParams.iterations, MIN_PIN_PBKDF2_ITERATIONS);
  if (
    params.backup.kdfParams.alg !== 'PBKDF2-SHA256' ||
    !Number.isInteger(params.backup.kdfParams.iterations) ||
    params.backup.kdfParams.iterations < MIN_PIN_PBKDF2_ITERATIONS ||
    !Number.isInteger(iterations) ||
    iterations < MIN_PIN_PBKDF2_ITERATIONS
  ) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Thông số bảo vệ bản sao lưu không hợp lệ.');
  }

  const cryptoObj = getWebCrypto();
  const subtle = cryptoObj.subtle;
  const oldSaltBytes = base64UrlToBytes(params.backup.kdfSalt);
  const oldIvBytes = base64UrlToBytes(params.backup.iv);
  const aadBytes = buildBackupAad(params.userPublicId, params.backup.keyFingerprint);

  const oldPinAesKey = await derivePinAesKey(
    params.currentPin,
    oldSaltBytes,
    params.backup.kdfParams.iterations,
  );

  let decryptedBytes: Uint8Array<ArrayBuffer>;
  try {
    const buf = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: oldIvBytes,
        additionalData: aadBytes,
        tagLength: 128,
      },
      oldPinAesKey,
      base64UrlToBytes(params.backup.encryptedKeyBlob),
    );
    decryptedBytes = new Uint8Array(buf);
  } catch {
    throw new E2eeCryptoError('BACKUP_DECRYPT_FAILED', 'Mã PIN hiện tại không đúng.');
  }

  let parsed: SerializedBackupKeyCleartext;
  try {
    parsed = JSON.parse(bytesToUtf8(decryptedBytes)) as SerializedBackupKeyCleartext;
  } finally {
    decryptedBytes.fill(0);
  }

  try {
    const identityPublicJwk = normalizePublicP256Jwk(parsed.identityPublicJwk);
    const signingPublicJwk = normalizePublicP256Jwk(parsed.signingPublicJwk);
    const computedFingerprint = await computeDeviceKeyFingerprint(
      identityPublicJwk,
      signingPublicJwk,
    );

    if (computedFingerprint !== params.backup.keyFingerprint) {
      throw new E2eeCryptoError(
        'BACKUP_DECRYPT_FAILED',
        'Dữ liệu khóa trong bản sao lưu không toàn vẹn.',
      );
    }

    const cleartextBundle: SerializedBackupKeyCleartext = {
      v: 1,
      keyFingerprint: computedFingerprint,
      identityPrivateJwk: {
        ...identityPublicJwk,
        d: parsed.identityPrivateJwk.d,
      },
      identityPublicJwk,
      signingPrivateJwk: {
        ...signingPublicJwk,
        d: parsed.signingPrivateJwk.d,
      },
      signingPublicJwk,
    };

    // Sinh muối và IV hoàn toàn mới, mã hóa lại cặp khóa gốc bằng mã PIN mới.
    const newSaltBytes = randomBytes(16);
    const newIvBytes = randomBytes(12);
    const newPinAesKey = await derivePinAesKey(params.newPin, newSaltBytes, iterations);
    const nextPlaintextBytes = utf8ToBytes(JSON.stringify(cleartextBundle));

    let encryptedBuf: ArrayBuffer;
    try {
      encryptedBuf = await subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: newIvBytes,
          additionalData: aadBytes,
          tagLength: 128,
        },
        newPinAesKey,
        nextPlaintextBytes,
      );
    } finally {
      nextPlaintextBytes.fill(0);
      cleartextBundle.identityPrivateJwk.d = '';
      cleartextBundle.signingPrivateJwk.d = '';
    }

    const [nonExtractableIdentityPriv, nonExtractableSigningPriv] = await Promise.all([
      subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          x: identityPublicJwk.x,
          y: identityPublicJwk.y,
          d: parsed.identityPrivateJwk.d,
        },
        { name: 'ECDH', namedCurve: 'P-256' },
        false, // extractable: false
        ['deriveBits'],
      ),
      subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          x: signingPublicJwk.x,
          y: signingPublicJwk.y,
          d: parsed.signingPrivateJwk.d,
        },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, // extractable: false
        ['sign'],
      ),
    ]);

    const localMaterial: E2eeDeviceKeyPairMaterial = {
      userPublicId: params.userPublicId,
      devicePublicId: cryptoObj.randomUUID(),
      keyFingerprint: computedFingerprint,
      identityPrivateKey: nonExtractableIdentityPriv,
      identityPublicKeyJwk: identityPublicJwk,
      signingPrivateKey: nonExtractableSigningPriv,
      signingPublicKeyJwk: signingPublicJwk,
      createdAtIso: new Date().toISOString(),
      isBackupKey: true,
    };

    if (params.persistLocally !== false) {
      await saveDeviceKeyMaterial(localMaterial, 'backup');
    }

    return {
      backup: {
        encryptedKeyBlob: bytesToBase64Url(new Uint8Array(encryptedBuf)),
        kdfSalt: bytesToBase64Url(newSaltBytes),
        kdfParams: {
          alg: 'PBKDF2-SHA256',
          iterations,
        },
        iv: bytesToBase64Url(newIvBytes),
        keyFingerprint: computedFingerprint,
        version: params.backup.version + 1,
      },
      publicRegistration: {
        identityPublicKeyJwk: identityPublicJwk,
        signingPublicKeyJwk: signingPublicJwk,
        keyFingerprint: computedFingerprint,
        deviceLabel: 'Khóa đồng bộ tin nhắn',
      },
      localMaterial,
    };
  } finally {
    parsed.identityPrivateJwk.d = '';
    parsed.signingPrivateJwk.d = '';
  }
}
