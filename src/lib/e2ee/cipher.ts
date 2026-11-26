import { sanitizeDecryptedMessageMediaPayload } from '@/lib/e2ee/media-cipher';
import {
  E2eeCryptoError,
  type DecryptedDirectMessagePayload,
  type DecryptedMessageMediaPayload,
  type DecryptedMessageReplyPayload,
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
const MAX_CACHED_VERIFY_CRYPTO_KEYS = 64;
const MAX_CACHED_FINGERPRINTS = 128;

const cachedEcdsaVerifyKeys = new Map<string, Promise<CryptoKey>>();
const cachedDeviceFingerprints = new Map<string, Promise<string>>();

async function getOrImportEcdsaVerifyKey(
  subtle: SubtleCrypto,
  jwk: E2eePublicJwk,
): Promise<CryptoKey> {
  const cacheKey = `${jwk.x}|${jwk.y}`;
  const existing = cachedEcdsaVerifyKeys.get(cacheKey);
  if (existing) {
    cachedEcdsaVerifyKeys.delete(cacheKey);
    cachedEcdsaVerifyKeys.set(cacheKey, existing);
    return existing;
  }

  const importPromise = subtle
    .importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    .catch((err) => {
      cachedEcdsaVerifyKeys.delete(cacheKey);
      throw err;
    });

  cachedEcdsaVerifyKeys.set(cacheKey, importPromise);
  while (cachedEcdsaVerifyKeys.size > MAX_CACHED_VERIFY_CRYPTO_KEYS) {
    const oldest = cachedEcdsaVerifyKeys.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cachedEcdsaVerifyKeys.delete(oldest);
  }
  return importPromise;
}

async function getCachedDeviceKeyFingerprint(
  identityJwk: E2eePublicJwk,
  signingJwk: E2eePublicJwk,
): Promise<string> {
  const cacheKey = `${identityJwk.x}|${identityJwk.y}|${signingJwk.x}|${signingJwk.y}`;
  const existing = cachedDeviceFingerprints.get(cacheKey);
  if (existing) {
    return existing;
  }

  const fpPromise = computeDeviceKeyFingerprint(identityJwk, signingJwk).catch((err) => {
    cachedDeviceFingerprints.delete(cacheKey);
    throw err;
  });

  cachedDeviceFingerprints.set(cacheKey, fpPromise);
  while (cachedDeviceFingerprints.size > MAX_CACHED_FINGERPRINTS) {
    const oldest = cachedDeviceFingerprints.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cachedDeviceFingerprints.delete(oldest);
  }
  return fpPromise;
}

export function clearCachedE2eeCryptoHelpers(): void {
  cachedEcdsaVerifyKeys.clear();
  cachedDeviceFingerprints.clear();
}

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

export const MAX_REPLY_EXCERPT_LENGTH = 140;

const REPLY_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIDI_AND_CONTROL_REGEX =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

export function sanitizeReplyTextExcerpt(raw: string): string {
  const cleaned = sanitizeChatPlaintext(raw)
    .replace(BIDI_AND_CONTROL_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= MAX_REPLY_EXCERPT_LENGTH) {
    return cleaned;
  }
  return codePoints.slice(0, MAX_REPLY_EXCERPT_LENGTH).join('');
}

export function sanitizeDecryptedMessageReplyPayload(
  raw: unknown,
): DecryptedMessageReplyPayload | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = raw as Partial<DecryptedMessageReplyPayload>;
  if (
    typeof candidate.messagePublicId !== 'string' ||
    !REPLY_UUID_V4_REGEX.test(candidate.messagePublicId.trim()) ||
    typeof candidate.senderPublicId !== 'string' ||
    !REPLY_UUID_V4_REGEX.test(candidate.senderPublicId.trim()) ||
    (candidate.messageType !== 'text' &&
      candidate.messageType !== 'image' &&
      candidate.messageType !== 'voice') ||
    typeof candidate.textExcerpt !== 'string'
  ) {
    return undefined;
  }
  return {
    messagePublicId: candidate.messagePublicId.trim().toLowerCase(),
    senderPublicId: candidate.senderPublicId.trim().toLowerCase(),
    messageType: candidate.messageType,
    textExcerpt: sanitizeReplyTextExcerpt(candidate.textExcerpt),
  };
}

export interface EncryptDirectMessageParams {
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly plaintext: string;
  readonly media?: DecryptedMessageMediaPayload;
  readonly replyTo?: DecryptedMessageReplyPayload;
  readonly forwarded?: boolean;
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

  const sanitizedMedia = params.media
    ? sanitizeDecryptedMessageMediaPayload(params.media)
    : undefined;
  if (params.media && !sanitizedMedia) {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Thông tin tệp đính kèm không hợp lệ.');
  }

  const sanitizedReplyTo = params.replyTo
    ? sanitizeDecryptedMessageReplyPayload(params.replyTo)
    : undefined;
  if (params.replyTo && !sanitizedReplyTo) {
    throw new E2eeCryptoError('INVALID_KEY_FORMAT', 'Thông tin trích dẫn trả lời không hợp lệ.');
  }

  const payloadObject: DecryptedDirectMessagePayload = {
    v: 1,
    text: cleanText,
    sentAt,
    ...(sanitizedMedia ? { media: sanitizedMedia } : {}),
    ...(sanitizedReplyTo ? { replyTo: sanitizedReplyTo } : {}),
    ...(params.forwarded ? { forwarded: true } : {}),
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

  // Tập hợp danh sách thiết bị nhận theo thứ tự ưu tiên chặt chẽ (tối đa MAX_E2EE_TARGET_DEVICES = 20):
  // 1. Thiết bị đang gửi (`senderDevice`) — luôn có mặt để thiết bị hiện tại đọc lại được.
  // 2. Khóa Công khai Đồng bộ (`isSyncKey === true`) của cả người nhận lẫn người gửi — TUYỆT ĐỐI không bao giờ bị cắt.
  // 3. Các thiết bị hoạt động còn lại cân bằng xen kẽ giữa 2 phía.
  const uniqueTargets = new Map<string, E2eeTargetDevicePublicKey>();
  const addTargetIfSpace = (dev: E2eeTargetDevicePublicKey) => {
    if (uniqueTargets.has(dev.keyFingerprint) || uniqueTargets.size >= MAX_E2EE_TARGET_DEVICES) {
      return;
    }
    uniqueTargets.set(dev.keyFingerprint, dev);
  };

  addTargetIfSpace({
    devicePublicId: params.senderDevice.devicePublicId,
    keyFingerprint: params.senderDevice.keyFingerprint,
    isSyncKey: params.senderDevice.isBackupKey === true,
    identityPublicKeyJwk: params.senderDevice.identityPublicKeyJwk,
    signingPublicKeyJwk: params.senderDevice.signingPublicKeyJwk,
  });

  for (const dev of params.recipientDevices) {
    if (dev.isSyncKey) {
      addTargetIfSpace(dev);
    }
  }
  if (params.senderOtherDevices) {
    for (const dev of params.senderOtherDevices) {
      if (dev.isSyncKey) {
        addTargetIfSpace(dev);
      }
    }
  }

  const remainingRecipient = params.recipientDevices.filter(
    (d) => !uniqueTargets.has(d.keyFingerprint),
  );
  const remainingSender = (params.senderOtherDevices ?? []).filter(
    (d) => !uniqueTargets.has(d.keyFingerprint),
  );
  const maxLoop = Math.max(remainingRecipient.length, remainingSender.length);
  for (let idx = 0; idx < maxLoop && uniqueTargets.size < MAX_E2EE_TARGET_DEVICES; idx += 1) {
    const recDev = remainingRecipient[idx];
    if (recDev) {
      addTargetIfSpace(recDev);
    }
    const sndDev = remainingSender[idx];
    if (sndDev) {
      addTargetIfSpace(sndDev);
    }
  }

  const targetList = Array.from(uniqueTargets.values());
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
    const expectedFingerprint = await getCachedDeviceKeyFingerprint(
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

  // Bước 1: Xác minh chữ ký ECDSA P-256 trước khi giải mã (dùng LRU cache khóa công khai đã importKey).
  const signingPublicKey = await getOrImportEcdsaVerifyKey(subtle, verifiedSigningJwk);

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

  // Bước 2: Thử mở bọc khóa phiên bằng TẤT CẢ các khóa riêng hợp lệ đang có trong IndexedDB
  // (bao gồm khóa thiết bị chính, khóa hộp thư mặc định và khóa đồng bộ khôi phục từ mã PIN).
  const candidatePairs: {
    readonly material: E2eeDeviceKeyPairMaterial;
    readonly wrappedEntry: WrappedMessageKeyPayload;
  }[] = [];

  for (const material of params.receiverKeyMaterials) {
    const candidate = header.wrappedKeys?.[material.keyFingerprint];
    if (candidate) {
      candidatePairs.push({ material, wrappedEntry: candidate });
    }
  }

  if (candidatePairs.length === 0) {
    throw new E2eeCryptoError(
      'MISSING_WRAPPED_KEY',
      'Tin nhắn này được gửi trước khi thiết bị hiện tại được đồng bộ.',
    );
  }

  const aadBytes = utf8ToBytes(aadString);
  const contentIv = base64UrlToBytes(header.iv);

  let lastDecryptError: unknown = null;
  for (const { material, wrappedEntry } of candidatePairs) {
    try {
      const ephemeralPubKey = await subtle.importKey(
        'jwk',
        normalizePublicP256Jwk(wrappedEntry.ephemeralPublicKeyJwk),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );

      const wrappingKey = await deriveWrappingAesKey({
        privateKey: material.identityPrivateKey,
        publicKey: ephemeralPubKey,
        conversationPublicId: params.conversationPublicId,
        targetKeyFingerprint: material.keyFingerprint,
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

      const parsed = JSON.parse(
        bytesToUtf8(decryptedBuf),
      ) as Partial<DecryptedDirectMessagePayload>;
      if (typeof parsed.text !== 'string') {
        throw new Error('Invalid payload');
      }

      const sanitizedMedia =
        parsed.media !== undefined ? sanitizeDecryptedMessageMediaPayload(parsed.media) : undefined;
      const sanitizedReplyTo =
        parsed.replyTo !== undefined
          ? sanitizeDecryptedMessageReplyPayload(parsed.replyTo)
          : undefined;

      return {
        v: 1,
        text: sanitizeChatPlaintext(parsed.text),
        sentAt: typeof parsed.sentAt === 'string' ? parsed.sentAt : new Date().toISOString(),
        ...(sanitizedMedia ? { media: sanitizedMedia } : {}),
        ...(sanitizedReplyTo ? { replyTo: sanitizedReplyTo } : {}),
        ...(parsed.forwarded === true ? { forwarded: true } : {}),
      };
    } catch (error) {
      lastDecryptError = error;
    }
  }

  if (lastDecryptError instanceof E2eeCryptoError) {
    throw lastDecryptError;
  }
  throw new E2eeCryptoError(
    'AAD_OR_CIPHERTEXT_TAMPERED',
    'Không thể giải mã tin nhắn: dữ liệu hoặc ngữ cảnh xác thực không khớp.',
  );
}
