import {
  E2eeCryptoError,
  type DecryptedDirectMessagePayload,
  type E2eeDeviceKeyPairMaterial,
  type E2eePublicJwk,
  type E2eeTargetDevicePublicKey,
  type EncryptedDirectMessageEnvelope,
  type MessageCryptoHeader,
  type WrappedMessageKeyPayload,
} from '@/lib/e2ee/types';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  computeDeviceKeyFingerprint,
  getWebCrypto,
  normalizePublicP256Jwk,
  randomBytes,
  sanitizeChatPlaintext,
  utf8ToBytes,
} from '@/lib/e2ee/utils';

export const MAX_E2EE_TARGET_DEVICES = 20;

/**
 * Chuỗi AAD chuẩn hóa: `conversationPublicId|senderPublicId|clientMsgId`
 * Chống đánh tráo bản mã (cut-and-paste / replay) sang cuộc trò chuyện hoặc người gửi khác.
 */
export function buildMessageAadString(params: {
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
}): string {
  return `${params.conversationPublicId}|${params.senderPublicId}|${params.clientMsgId}`;
}

/**
 * Dữ liệu chuẩn hóa được ký bằng ECDSA P-256 (`(AAD || senderKeyFingerprint || iv || ciphertext)`).
 */
export function buildMessageSignatureTranscript(params: {
  readonly aadString: string;
  readonly senderKeyFingerprint: string;
  readonly iv: string;
  readonly ciphertext: string;
}): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(
    `TOMATO-E2EE-SIG-V1|${params.aadString}|${params.senderKeyFingerprint}|${params.iv}|${params.ciphertext}`,
  );
}

async function deriveWrappingAesKey(params: {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly conversationPublicId: string;
  readonly targetKeyFingerprint: string;
  readonly hkdfSalt: Uint8Array<ArrayBuffer>;
}): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;
  const sharedBits = await subtle.deriveBits(
    {
      name: 'ECDH',
      public: params.publicKey,
    },
    params.privateKey,
    256,
  );

  const hkdfBaseKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const infoBytes = utf8ToBytes(
    `tomato-e2ee-wrap-v1|${params.conversationPublicId}|${params.targetKeyFingerprint}`,
  );

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: params.hkdfSalt,
      info: infoBytes,
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptDirectMessageParams {
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly plaintext: string;
  readonly senderDevice: E2eeDeviceKeyPairMaterial;
  readonly recipientDevices: readonly E2eeTargetDevicePublicKey[];
  readonly senderOtherDevices?: readonly E2eeTargetDevicePublicKey[];
  readonly sentAt?: string;
}

/**
 * Mã hóa tin nhắn 1-1 phía Client:
 * 1. Lọc ký tự RTL override / điều khiển độc hại.
 * 2. Mã hóa nội dung bằng khóa phiên 256-bit `AES-256-GCM` kèm AAD `conversationPublicId|senderPublicId|clientMsgId`.
 * 3. Bọc khóa phiên cho từng thiết bị của người nhận và các thiết bị của chính người gửi qua `ECDH P-256` + `HKDF-SHA256`.
 * 4. Ký xác thực người gửi bằng `ECDSA P-256` trên `(AAD || senderKeyFingerprint || iv || ciphertext)`.
 */
export async function encryptDirectMessage(
  params: EncryptDirectMessageParams,
): Promise<EncryptedDirectMessageEnvelope> {
  if (params.recipientDevices.length === 0) {
    throw new E2eeCryptoError(
      'NO_RECIPIENT_KEYS',
      'Người nhận chưa kích hoạt hộp thư bảo mật trên thiết bị nào.',
    );
  }

  const subtle = getWebCrypto().subtle;
  const cleanText = sanitizeChatPlaintext(params.plaintext);
  const sentAt = params.sentAt ?? new Date().toISOString();
  const aadString = buildMessageAadString({
    conversationPublicId: params.conversationPublicId,
    senderPublicId: params.senderPublicId,
    clientMsgId: params.clientMsgId,
  });
  const aadBytes = utf8ToBytes(aadString);

  // Sinh khóa nội dung ngẫu nhiên 256-bit (32 bytes) và IV 96-bit (12 bytes).
  const rawMessageKey = randomBytes(32);
  const contentIv = randomBytes(12);
  const contentCryptoKey = await subtle.importKey(
    'raw',
    rawMessageKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const payloadObject: DecryptedDirectMessagePayload = {
    v: 1,
    text: cleanText,
    sentAt,
  };
  const plaintextBytes = utf8ToBytes(JSON.stringify(payloadObject));

  const encryptedContentBuf = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: contentIv,
      additionalData: aadBytes,
      tagLength: 128,
    },
    contentCryptoKey,
    plaintextBytes,
  );

  const ciphertext = bytesToBase64Url(new Uint8Array(encryptedContentBuf));
  const contentIvB64 = bytesToBase64Url(contentIv);

  // Tập hợp danh sách thiết bị nhận (bao gồm thiết bị của người nhận + thiết bị hiện tại & thiết bị khác của người gửi).
  const uniqueTargets = new Map<string, E2eeTargetDevicePublicKey>();
  for (const dev of params.recipientDevices) {
    uniqueTargets.set(dev.keyFingerprint, dev);
  }
  if (params.senderOtherDevices) {
    for (const dev of params.senderOtherDevices) {
      uniqueTargets.set(dev.keyFingerprint, dev);
    }
  }
  uniqueTargets.set(params.senderDevice.keyFingerprint, {
    devicePublicId: params.senderDevice.devicePublicId,
    keyFingerprint: params.senderDevice.keyFingerprint,
    identityPublicKeyJwk: params.senderDevice.identityPublicKeyJwk,
    signingPublicKeyJwk: params.senderDevice.signingPublicKeyJwk,
  });

  const targetList = Array.from(uniqueTargets.values()).slice(0, MAX_E2EE_TARGET_DEVICES);
  const wrappedKeys: Record<string, WrappedMessageKeyPayload> = {};

  for (const target of targetList) {
    const targetIdentityPubKey = await subtle.importKey(
      'jwk',
      normalizePublicP256Jwk(target.identityPublicKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const ephemeralKeyPair = await subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const ephemeralPubJwk = normalizePublicP256Jwk(
      await subtle.exportKey('jwk', ephemeralKeyPair.publicKey),
    );

    const wrapIv = randomBytes(12);
    const wrappingKey = await deriveWrappingAesKey({
      privateKey: ephemeralKeyPair.privateKey,
      publicKey: targetIdentityPubKey,
      conversationPublicId: params.conversationPublicId,
      targetKeyFingerprint: target.keyFingerprint,
      hkdfSalt: contentIv,
    });

    const wrappedBuf = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: wrapIv,
        additionalData: aadBytes,
        tagLength: 128,
      },
      wrappingKey,
      rawMessageKey,
    );

    wrappedKeys[target.keyFingerprint] = {
      ephemeralPublicKeyJwk: ephemeralPubJwk,
      iv: bytesToBase64Url(wrapIv),
      wrappedKey: bytesToBase64Url(new Uint8Array(wrappedBuf)),
    };
  }

  // Xóa khóa phiên raw khỏi RAM ngay sau khi bọc xong.
  rawMessageKey.fill(0);

  // Ký ECDSA P-256 bằng signingPrivateKey của thiết bị gửi lên (AAD || senderKeyFingerprint || iv || ciphertext).
  const transcriptBytes = buildMessageSignatureTranscript({
    aadString,
    senderKeyFingerprint: params.senderDevice.keyFingerprint,
    iv: contentIvB64,
    ciphertext,
  });

  const signatureBuf = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    params.senderDevice.signingPrivateKey,
    transcriptBytes,
  );

  const cryptoHeader: MessageCryptoHeader = {
    v: 1,
    alg: 'ECDH-P256-HKDF-AES256GCM',
    iv: contentIvB64,
    senderDevicePublicId: params.senderDevice.devicePublicId,
    senderKeyFingerprint: params.senderDevice.keyFingerprint,
    senderSigningPublicKeyJwk: params.senderDevice.signingPublicKeyJwk,
    signature: bytesToBase64Url(new Uint8Array(signatureBuf)),
    wrappedKeys,
  };

  return {
    ciphertext,
    cryptoHeader,
  };
}

export interface ReEncryptEditedDirectMessageParams extends EncryptDirectMessageParams {
  /** IV AES-GCM của phiên bản trước đó (nếu có) để khẳng định tuyệt đối không tái sử dụng IV. */
  readonly previousIv?: string | null;
}

/**
 * Mã hóa lại tin nhắn văn bản khi chỉnh sửa (M10):
 * - Giữ nguyên AAD `conversationPublicId|senderPublicId|clientMsgId` để bảo toàn chống đánh tráo bản mã.
 * - BẮT BUỘC sinh mới contentKey 256-bit, IV 96-bit mới hoàn toàn (`iv !== previousIv`),
 *   ephemeral ECDH keys + wrap IV mới cho mọi thiết bị, và ký lại bằng ECDSA P-256 `signingPrivateKey`.
 */
export async function reEncryptEditedDirectMessage(
  params: ReEncryptEditedDirectMessageParams,
): Promise<EncryptedDirectMessageEnvelope> {
  const cleanText = sanitizeChatPlaintext(params.plaintext).trim();
  if (!cleanText) {
    throw new E2eeCryptoError(
      'INVALID_KEY_FORMAT',
      'Nội dung tin nhắn chỉnh sửa không được để trống.',
    );
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const envelope = await encryptDirectMessage({
      ...params,
      plaintext: cleanText,
    });
    if (!params.previousIv || envelope.cryptoHeader.iv !== params.previousIv) {
      return envelope;
    }
  }

  throw new E2eeCryptoError(
    'WEBCRYPTO_UNAVAILABLE',
    'Không thể tạo vector khởi tạo mã hóa mới an toàn. Vui lòng thử lại.',
  );
}

export interface DecryptDirectMessageParams {
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly ciphertext: string;
  readonly cryptoHeader: MessageCryptoHeader;
  readonly receiverKeyMaterials: readonly E2eeDeviceKeyPairMaterial[];
  /**
   * Danh sách khóa công khai đã đăng ký của người gửi (lấy từ GET /api/v1/e2ee/users/:senderPublicId/keys).
   * Nếu truyền vào, bắt buộc đối chiếu khóa chữ ký thuộc đúng thiết bị đã đăng ký của người gửi.
   */
  readonly expectedSenderDevices?: readonly E2eeTargetDevicePublicKey[];
}

/**
 * Giải mã tin nhắn 1-1 phía Client:
 * 1. Đối chiếu khóa chữ ký của thiết bị gửi và xác minh chữ ký ECDSA P-256 trên `(AAD || ciphertext || iv)`.
 * 2. Tìm khóa bọc khớp với `keyFingerprint` của thiết bị hiện tại (hoặc khóa khôi phục từ mã PIN).
 * 3. Mở bọc khóa phiên và giải mã `AES-256-GCM` kèm AAD `conversationPublicId|senderPublicId|clientMsgId`.
 */
export async function decryptDirectMessage(
  params: DecryptDirectMessageParams,
): Promise<DecryptedDirectMessagePayload> {
  const subtle = getWebCrypto().subtle;
  const header = params.cryptoHeader;

  if (!header || header.alg !== 'ECDH-P256-HKDF-AES256GCM' || !header.signature) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Cấu trúc bảo mật của tin nhắn không hợp lệ.');
  }

  let verifiedSigningJwk: E2eePublicJwk = normalizePublicP256Jwk(header.senderSigningPublicKeyJwk);

  if (params.expectedSenderDevices && params.expectedSenderDevices.length > 0) {
    const matchedSenderDevice = params.expectedSenderDevices.find(
      (dev) => dev.keyFingerprint === header.senderKeyFingerprint,
    );
    if (!matchedSenderDevice) {
      throw new E2eeCryptoError(
        'UNTRUSTED_SIGNING_KEY',
        'Không tìm thấy khóa xác thực đã đăng ký của thiết bị gửi.',
      );
    }
    const expectedFingerprint = await computeDeviceKeyFingerprint(
      matchedSenderDevice.identityPublicKeyJwk,
      matchedSenderDevice.signingPublicKeyJwk,
    );
    if (
      expectedFingerprint !== header.senderKeyFingerprint ||
      matchedSenderDevice.signingPublicKeyJwk.x !== verifiedSigningJwk.x ||
      matchedSenderDevice.signingPublicKeyJwk.y !== verifiedSigningJwk.y
    ) {
      throw new E2eeCryptoError(
        'UNTRUSTED_SIGNING_KEY',
        'Khóa chữ ký của thiết bị gửi không khớp với hồ sơ khóa công khai.',
      );
    }
    verifiedSigningJwk = normalizePublicP256Jwk(matchedSenderDevice.signingPublicKeyJwk);
  }

  const aadString = buildMessageAadString({
    conversationPublicId: params.conversationPublicId,
    senderPublicId: params.senderPublicId,
    clientMsgId: params.clientMsgId,
  });

  // Bước 1: Xác minh chữ ký ECDSA P-256 trước khi giải mã (chống giả mạo người gửi / tampering).
  const signingPublicKey = await subtle.importKey(
    'jwk',
    verifiedSigningJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const transcriptBytes = buildMessageSignatureTranscript({
    aadString,
    senderKeyFingerprint: header.senderKeyFingerprint,
    iv: header.iv,
    ciphertext: params.ciphertext,
  });

  let isSignatureValid = false;
  try {
    isSignatureValid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingPublicKey,
      base64UrlToBytes(header.signature),
      transcriptBytes,
    );
  } catch {
    isSignatureValid = false;
  }

  if (!isSignatureValid) {
    throw new E2eeCryptoError(
      'INVALID_SIGNATURE',
      'Chữ ký xác thực người gửi không hợp lệ hoặc dữ liệu đã bị can thiệp.',
    );
  }

  // Bước 2: Tìm entry bọc khóa khớp với một trong các khóa riêng của người dùng hiện tại.
  let matchedMaterial: E2eeDeviceKeyPairMaterial | null = null;
  let wrappedEntry: WrappedMessageKeyPayload | null = null;

  for (const material of params.receiverKeyMaterials) {
    const candidate = header.wrappedKeys?.[material.keyFingerprint];
    if (candidate) {
      matchedMaterial = material;
      wrappedEntry = candidate;
      break;
    }
  }

  if (!matchedMaterial || !wrappedEntry) {
    throw new E2eeCryptoError(
      'MISSING_WRAPPED_KEY',
      'Tin nhắn này được gửi trước khi thiết bị hiện tại được đồng bộ.',
    );
  }

  const aadBytes = utf8ToBytes(aadString);
  const contentIv = base64UrlToBytes(header.iv);

  try {
    const ephemeralPubKey = await subtle.importKey(
      'jwk',
      normalizePublicP256Jwk(wrappedEntry.ephemeralPublicKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const wrappingKey = await deriveWrappingAesKey({
      privateKey: matchedMaterial.identityPrivateKey,
      publicKey: ephemeralPubKey,
      conversationPublicId: params.conversationPublicId,
      targetKeyFingerprint: matchedMaterial.keyFingerprint,
      hkdfSalt: contentIv,
    });

    const rawMessageKeyBuf = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(wrappedEntry.iv),
        additionalData: aadBytes,
        tagLength: 128,
      },
      wrappingKey,
      base64UrlToBytes(wrappedEntry.wrappedKey),
    );

    const contentCryptoKey = await subtle.importKey(
      'raw',
      rawMessageKeyBuf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    const decryptedBuf = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: contentIv,
        additionalData: aadBytes,
        tagLength: 128,
      },
      contentCryptoKey,
      base64UrlToBytes(params.ciphertext),
    );

    const parsed = JSON.parse(bytesToUtf8(decryptedBuf)) as Partial<DecryptedDirectMessagePayload>;
    if (typeof parsed.text !== 'string') {
      throw new Error('Invalid payload');
    }

    return {
      v: 1,
      text: sanitizeChatPlaintext(parsed.text),
      sentAt: typeof parsed.sentAt === 'string' ? parsed.sentAt : new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof E2eeCryptoError) {
      throw error;
    }
    throw new E2eeCryptoError(
      'AAD_OR_CIPHERTEXT_TAMPERED',
      'Không thể giải mã tin nhắn: dữ liệu hoặc ngữ cảnh xác thực không khớp.',
    );
  }
}
