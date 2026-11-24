import {
  E2eeCryptoError,
  type DecryptedMediaKind,
  type DecryptedMessageMediaPayload,
} from '@/lib/e2ee/types';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  getWebCrypto,
  randomBytes,
  utf8ToBytes,
} from '@/lib/e2ee/utils';

export const MAX_CHAT_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VOICE_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGE_MAX_DIMENSION = 2048;
export const MAX_CHAT_IMAGE_THUMBNAIL_DIMENSION = 32;
export const MAX_CHAT_IMAGE_THUMBNAIL_DATA_URL_LENGTH = 4096;
export const MAX_CHAT_IMAGES_PER_BATCH = 5;
export const MAX_CHAT_VOICE_DURATION_MS = 120_000;
export const MIN_CHAT_VOICE_DURATION_MS = 500;
export const VOICE_WAVEFORM_BAR_COUNT = 32;

const SAFE_THUMBNAIL_DATA_URL_REGEX = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VOICE_MIME_PREFIXES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg'] as const;

export type SupportedChatImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

function toOwnedArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return copy;
}

/**
 * Kiểm tra magic bytes chuẩn cho PNG / JPEG / WebP và từ chối tuyệt đối SVG / dữ liệu giả mạo.
 */
export function detectSupportedChatImageMime(
  bytes: Uint8Array,
  declaredMime?: string,
): SupportedChatImageMime {
  const normalizedDeclared = (declaredMime ?? '').trim().toLowerCase();
  if (normalizedDeclared.includes('svg')) {
    throw new E2eeCryptoError(
      'MEDIA_INVALID_TYPE',
      'Định dạng ảnh này không được hỗ trợ. Vui lòng chọn ảnh PNG, JPG hoặc WebP.',
    );
  }

  if (bytes.byteLength < 12) {
    throw new E2eeCryptoError(
      'MEDIA_INVALID_TYPE',
      'Tệp ảnh không hợp lệ. Vui lòng chọn ảnh PNG, JPG hoặc WebP.',
    );
  }

  // Chặn SVG được ngụy trang đuôi .png/.jpg (bắt đầu bằng <svg, <?xml, <!doctype).
  const headAscii = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(256, bytes.byteLength)))
    .trimStart()
    .toLowerCase();
  if (
    headAscii.startsWith('<svg') ||
    headAscii.startsWith('<?xml') ||
    headAscii.includes('<svg') ||
    headAscii.startsWith('<!doctype svg')
  ) {
    throw new E2eeCryptoError(
      'MEDIA_INVALID_TYPE',
      'Định dạng ảnh này không được hỗ trợ. Vui lòng chọn ảnh PNG, JPG hoặc WebP.',
    );
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Chỉ hỗ trợ ảnh định dạng PNG, JPG hoặc WebP.');
}

export function normalizeVoiceMimeType(rawMimeType: string): string {
  const cleaned = rawMimeType.trim().toLowerCase();
  for (const prefix of ALLOWED_VOICE_MIME_PREFIXES) {
    if (cleaned === prefix || cleaned.startsWith(`${prefix};`)) {
      return cleaned;
    }
  }
  throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Định dạng âm thanh không được hỗ trợ.');
}

export function validateVoiceBinaryInput(params: {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly durationMs: number;
}): { readonly mimeType: string; readonly durationMs: number } {
  if (params.bytes.byteLength === 0) {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Bản ghi âm trống, vui lòng thử lại.');
  }
  if (params.bytes.byteLength > MAX_CHAT_VOICE_INPUT_BYTES) {
    throw new E2eeCryptoError('MEDIA_TOO_LARGE', 'Tin nhắn thoại vượt quá giới hạn tối đa 5 MB.');
  }
  if (!Number.isFinite(params.durationMs) || params.durationMs < MIN_CHAT_VOICE_DURATION_MS) {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Tin nhắn thoại quá ngắn.');
  }
  if (params.durationMs > MAX_CHAT_VOICE_DURATION_MS) {
    throw new E2eeCryptoError('MEDIA_TOO_LARGE', 'Tin nhắn thoại có thời lượng tối đa 2 phút.');
  }

  return {
    mimeType: normalizeVoiceMimeType(params.mimeType),
    durationMs: Math.round(params.durationMs),
  };
}

export function sanitizeThumbnailDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CHAT_IMAGE_THUMBNAIL_DATA_URL_LENGTH ||
    !SAFE_THUMBNAIL_DATA_URL_REGEX.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Chuẩn hóa chuỗi mẫu biên độ âm thanh thành mảng số nguyên 0..100 dài đúng `barCount` (mặc định 32 thanh).
 */
export function normalizeWaveformBars(
  samples: readonly number[],
  barCount: number = VOICE_WAVEFORM_BAR_COUNT,
): number[] {
  const safeBarCount = Math.max(16, Math.min(48, Math.round(barCount)));
  if (samples.length === 0) {
    return Array.from({ length: safeBarCount }, (_, idx) => {
      const wave = Math.sin((idx / safeBarCount) * Math.PI);
      return Math.max(12, Math.round(18 + wave * 36));
    });
  }

  const buckets: number[] = [];
  for (let i = 0; i < safeBarCount; i += 1) {
    const start = Math.floor((i * samples.length) / safeBarCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / safeBarCount));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < samples.length; j += 1) {
      const val = samples[j];
      if (typeof val === 'number' && Number.isFinite(val)) {
        sum += Math.max(0, val);
        count += 1;
      }
    }
    buckets.push(count > 0 ? sum / count : 0);
  }

  const maxBucket = Math.max(...buckets, 0.001);
  return buckets.map((val) => {
    const normalized = Math.round((val / maxBucket) * 100);
    return Math.max(10, Math.min(100, normalized));
  });
}

/**
 * Kiểm tra & chuẩn hóa trường `media` giải mã được từ phong bì E2EE của tin nhắn.
 */
export function sanitizeDecryptedMessageMediaPayload(
  raw: unknown,
): DecryptedMessageMediaPayload | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const candidate = raw as Partial<DecryptedMessageMediaPayload>;
  if (candidate.kind !== 'image' && candidate.kind !== 'voice') {
    return undefined;
  }
  if (
    typeof candidate.attachmentPublicId !== 'string' ||
    !UUID_V4_REGEX.test(candidate.attachmentPublicId) ||
    typeof candidate.fileKey !== 'string' ||
    candidate.fileKey.length < 32 ||
    candidate.fileKey.length > 64 ||
    typeof candidate.fileIv !== 'string' ||
    candidate.fileIv.length < 12 ||
    candidate.fileIv.length > 32 ||
    typeof candidate.ciphertextSha256 !== 'string' ||
    !SHA256_HEX_REGEX.test(candidate.ciphertextSha256.toLowerCase()) ||
    typeof candidate.mimeType !== 'string' ||
    typeof candidate.sizeBytes !== 'number' ||
    !Number.isFinite(candidate.sizeBytes) ||
    candidate.sizeBytes <= 0
  ) {
    return undefined;
  }

  const normalizedMime = candidate.mimeType.trim().toLowerCase();
  if (candidate.kind === 'image') {
    if (!ALLOWED_IMAGE_MIMES.has(normalizedMime)) {
      return undefined;
    }
  } else {
    const validVoiceMime = ALLOWED_VOICE_MIME_PREFIXES.some(
      (prefix) => normalizedMime === prefix || normalizedMime.startsWith(`${prefix};`),
    );
    if (!validVoiceMime) {
      return undefined;
    }
  }

  const width =
    typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0
      ? Math.min(8192, Math.round(candidate.width))
      : undefined;
  const height =
    typeof candidate.height === 'number' &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
      ? Math.min(8192, Math.round(candidate.height))
      : undefined;
  const durationMs =
    typeof candidate.durationMs === 'number' &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs > 0
      ? Math.min(MAX_CHAT_VOICE_DURATION_MS, Math.round(candidate.durationMs))
      : undefined;
  const waveform = Array.isArray(candidate.waveform)
    ? candidate.waveform
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        .slice(0, 48)
        .map((v) => Math.max(6, Math.min(100, Math.round(v))))
    : undefined;
  const thumbnailDataUrl = sanitizeThumbnailDataUrl(candidate.thumbnailDataUrl);

  return {
    kind: candidate.kind,
    attachmentPublicId: candidate.attachmentPublicId.toLowerCase(),
    fileKey: candidate.fileKey,
    fileIv: candidate.fileIv,
    ciphertextSha256: candidate.ciphertextSha256.toLowerCase(),
    mimeType: normalizedMime,
    sizeBytes: Math.round(candidate.sizeBytes),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(waveform && waveform.length > 0 ? { waveform } : {}),
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
  };
}

/**
 * Chuỗi AAD gắn chặt tệp bản mã với đúng cuộc trò chuyện, người gửi, clientMsgId và loại tệp.
 * Ngăn chặn triệt để tấn công tráo tệp đính kèm giữa 2 tin nhắn khác nhau.
 */
export function buildMediaAadString(params: {
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly mediaKind: DecryptedMediaKind;
}): string {
  return `TOMATO-MEDIA-V1|${params.conversationPublicId}|${params.senderPublicId}|${params.clientMsgId}|${params.mediaKind}`;
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = toOwnedArrayBufferBytes(bytes);
  const digest = await getWebCrypto().subtle.digest('SHA-256', owned);
  return bytesToHex(new Uint8Array(digest));
}

export interface EncryptMediaBinaryParams {
  readonly plainBytes: Uint8Array;
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly mediaKind: DecryptedMediaKind;
}

export interface EncryptedMediaBinaryResult {
  readonly ciphertextBytes: Uint8Array<ArrayBuffer>;
  readonly ciphertextSizeBytes: number;
  readonly ciphertextSha256: string;
  readonly fileKey: string;
  readonly fileIv: string;
}

/**
 * Mã hóa nhị phân tệp ảnh HD / tin nhắn thoại bằng khóa tệp độc lập AES-256-GCM 256-bit,
 * tính mã băm toàn vẹn SHA-256 của bản mã và xóa sạch khóa thô khỏi RAM ngay sau khi mã hóa.
 */
export async function encryptMediaBinary(
  params: EncryptMediaBinaryParams,
): Promise<EncryptedMediaBinaryResult> {
  const maxAllowed =
    params.mediaKind === 'image' ? MAX_CHAT_IMAGE_INPUT_BYTES : MAX_CHAT_VOICE_INPUT_BYTES;
  if (params.plainBytes.byteLength === 0) {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Dữ liệu tệp đính kèm trống.');
  }
  if (params.plainBytes.byteLength > maxAllowed) {
    throw new E2eeCryptoError(
      'MEDIA_TOO_LARGE',
      params.mediaKind === 'image'
        ? 'Ảnh vượt quá giới hạn tối đa 10 MB.'
        : 'Tin nhắn thoại vượt quá giới hạn tối đa 5 MB.',
    );
  }

  const subtle = getWebCrypto().subtle;
  const rawFileKey = randomBytes(32);
  const rawFileIv = randomBytes(12);
  const aadBytes = utf8ToBytes(
    buildMediaAadString({
      conversationPublicId: params.conversationPublicId,
      senderPublicId: params.senderPublicId,
      clientMsgId: params.clientMsgId,
      mediaKind: params.mediaKind,
    }),
  );

  try {
    const cryptoKey = await subtle.importKey(
      'raw',
      rawFileKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    const encryptedBuf = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: rawFileIv,
        additionalData: aadBytes,
        tagLength: 128,
      },
      cryptoKey,
      toOwnedArrayBufferBytes(params.plainBytes),
    );

    const ciphertextBytes = new Uint8Array(encryptedBuf);
    const ciphertextSha256 = await computeSha256Hex(ciphertextBytes);
    const fileKey = bytesToBase64Url(rawFileKey);
    const fileIv = bytesToBase64Url(rawFileIv);

    return {
      ciphertextBytes,
      ciphertextSizeBytes: ciphertextBytes.byteLength,
      ciphertextSha256,
      fileKey,
      fileIv,
    };
  } finally {
    // Xóa sạch khóa thô và IV thô khỏi bộ đệm RAM ngay sau khi dùng.
    rawFileKey.fill(0);
    rawFileIv.fill(0);
  }
}

export interface DecryptMediaBinaryParams {
  readonly ciphertextBytes: Uint8Array;
  readonly fileKey: string;
  readonly fileIv: string;
  readonly expectedSha256: string;
  readonly conversationPublicId: string;
  readonly senderPublicId: string;
  readonly clientMsgId: string;
  readonly mediaKind: DecryptedMediaKind;
}

/**
 * Xác minh toàn vẹn SHA-256 fail-closed trước khi giải mã bản mã nhị phân AES-256-GCM trong RAM.
 */
export async function decryptMediaBinary(
  params: DecryptMediaBinaryParams,
): Promise<Uint8Array<ArrayBuffer>> {
  const expectedSha = params.expectedSha256.trim().toLowerCase();
  if (!SHA256_HEX_REGEX.test(expectedSha)) {
    throw new E2eeCryptoError('MEDIA_INTEGRITY_MISMATCH', 'Mã kiểm tra toàn vẹn tệp không hợp lệ.');
  }

  const actualSha = await computeSha256Hex(params.ciphertextBytes);
  if (actualSha !== expectedSha) {
    throw new E2eeCryptoError(
      'MEDIA_INTEGRITY_MISMATCH',
      'Tệp đính kèm không khớp kiểm tra toàn vẹn dữ liệu.',
    );
  }

  const rawFileKey = base64UrlToBytes(params.fileKey);
  const rawFileIv = base64UrlToBytes(params.fileIv);
  if (rawFileKey.byteLength !== 32 || rawFileIv.byteLength !== 12) {
    rawFileKey.fill(0);
    rawFileIv.fill(0);
    throw new E2eeCryptoError('MEDIA_DECRYPT_FAILED', 'Khóa giải mã tệp không hợp lệ.');
  }

  const aadBytes = utf8ToBytes(
    buildMediaAadString({
      conversationPublicId: params.conversationPublicId,
      senderPublicId: params.senderPublicId,
      clientMsgId: params.clientMsgId,
      mediaKind: params.mediaKind,
    }),
  );

  try {
    const subtle = getWebCrypto().subtle;
    const cryptoKey = await subtle.importKey(
      'raw',
      rawFileKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    const plainBuf = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: rawFileIv,
        additionalData: aadBytes,
        tagLength: 128,
      },
      cryptoKey,
      toOwnedArrayBufferBytes(params.ciphertextBytes),
    );

    return new Uint8Array(plainBuf);
  } catch (error) {
    if (error instanceof E2eeCryptoError) {
      throw error;
    }
    throw new E2eeCryptoError('MEDIA_DECRYPT_FAILED', 'Không thể giải mã tệp đính kèm.');
  } finally {
    rawFileKey.fill(0);
    rawFileIv.fill(0);
  }
}

export interface PreparedHdImageResult {
  readonly plainBytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: 'image/webp' | 'image/jpeg';
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnailDataUrl?: string;
}

function canvasToBlobAsync(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function decodeImageElementForCanvas(blob: Blob): Promise<{
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly dispose: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Dự phòng qua HTMLImageElement trên trình duyệt cũ không hỗ trợ option imageOrientation.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Không thể đọc dữ liệu ảnh.'));
      element.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

/**
 * Chuẩn hóa ảnh HD trên Client trước khi mã hóa:
 * - Kiểm tra dung lượng <= 10 MB và magic bytes (chỉ JPEG/PNG/WebP, cấm SVG).
 * - Xoay đúng chiều & xóa sạch 100% EXIF/GPS qua Canvas API, giữ cạnh dài tối đa 2048px (HD).
 * - Sinh thumbnail mờ nhẹ (~32px) để hiển thị mượt trong lúc tải ảnh HD.
 */
export async function prepareHdImageForEncryption(
  file: File | Blob,
): Promise<PreparedHdImageResult> {
  if (file.size <= 0) {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Tệp ảnh trống hoặc không hợp lệ.');
  }
  if (file.size > MAX_CHAT_IMAGE_INPUT_BYTES) {
    throw new E2eeCryptoError('MEDIA_TOO_LARGE', 'Ảnh vượt quá kích thước tối đa 10 MB.');
  }

  const rawBuf = await file.arrayBuffer();
  const rawBytes = new Uint8Array(rawBuf);
  const detectedMime = detectSupportedChatImageMime(rawBytes, file.type);

  if (typeof document === 'undefined') {
    throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Trình duyệt không hỗ trợ xử lý ảnh.');
  }

  const safeBlob = new Blob([rawBytes], { type: detectedMime });
  const decoded = await decodeImageElementForCanvas(safeBlob);

  try {
    if (decoded.width <= 0 || decoded.height <= 0) {
      throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Kích thước ảnh không hợp lệ.');
    }

    const scale = Math.min(
      1,
      MAX_CHAT_IMAGE_MAX_DIMENSION / Math.max(decoded.width, decoded.height),
    );
    const targetWidth = Math.max(1, Math.round(decoded.width * scale));
    const targetHeight = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Không thể khởi tạo bộ xử lý ảnh.');
    }

    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    // Ưu tiên WebP chất lượng cao (0.88), tự fallback sang JPEG nếu trình duyệt không xuất được WebP.
    const qualitySteps = [0.88, 0.8, 0.72] as const;
    let encodedBlob: Blob | null = null;
    let encodedMime: 'image/webp' | 'image/jpeg' = 'image/webp';

    for (const quality of qualitySteps) {
      const webpBlob = await canvasToBlobAsync(canvas, 'image/webp', quality);
      if (webpBlob && webpBlob.type === 'image/webp') {
        encodedBlob = webpBlob;
        encodedMime = 'image/webp';
      } else {
        const jpegBlob = await canvasToBlobAsync(canvas, 'image/jpeg', quality);
        encodedBlob = jpegBlob;
        encodedMime = 'image/jpeg';
      }
      if (encodedBlob && encodedBlob.size <= MAX_CHAT_IMAGE_INPUT_BYTES) {
        break;
      }
    }

    if (!encodedBlob || encodedBlob.size === 0) {
      throw new E2eeCryptoError('MEDIA_INVALID_TYPE', 'Không thể xử lý ảnh này.');
    }
    if (encodedBlob.size > MAX_CHAT_IMAGE_INPUT_BYTES) {
      throw new E2eeCryptoError('MEDIA_TOO_LARGE', 'Ảnh sau khi nén vẫn vượt quá 10 MB.');
    }

    // Tạo ảnh thu nhỏ mờ nhẹ (cạnh dài tối đa 32px) cho trải nghiệm tải mượt mà.
    const thumbScale = Math.min(
      1,
      MAX_CHAT_IMAGE_THUMBNAIL_DIMENSION / Math.max(targetWidth, targetHeight),
    );
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = Math.max(1, Math.round(targetWidth * thumbScale));
    thumbCanvas.height = Math.max(1, Math.round(targetHeight * thumbScale));
    const thumbCtx = thumbCanvas.getContext('2d');
    let thumbnailDataUrl: string | undefined;
    if (thumbCtx) {
      thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const rawThumb =
        thumbCanvas.toDataURL('image/webp', 0.55) || thumbCanvas.toDataURL('image/jpeg', 0.55);
      thumbnailDataUrl = sanitizeThumbnailDataUrl(rawThumb);
    }

    // Dọn kích thước canvas ngay để giải phóng bộ nhớ GPU/RAM.
    canvas.width = 0;
    canvas.height = 0;
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;

    const encodedBytes = new Uint8Array(await encodedBlob.arrayBuffer());
    return {
      plainBytes: encodedBytes,
      mimeType: encodedMime,
      sizeBytes: encodedBytes.byteLength,
      width: targetWidth,
      height: targetHeight,
      thumbnailDataUrl,
    };
  } finally {
    decoded.dispose();
  }
}

/**
 * Chọn codec ghi âm tương thích tốt nhất trên trình duyệt hiện tại
 * (ưu tiên Opus/WebM trên Chrome/Firefox/Edge, tự động fallback MP4/AAC cho Safari/iOS).
 */
export function pickSupportedVoiceRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ] as const;
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

/**
 * Tạo tên file tải ảnh xuống an toàn tự sinh theo thời gian cục bộ (`tomato-photo-YYYYMMDD-HHmmss.webp/.jpg/.png`),
 * tuyệt đối không tin bất kỳ tên file gốc hay chuỗi bên ngoài nào.
 */
export function buildSafePhotoDownloadFileName(mimeType?: string, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const normalized = (mimeType ?? '').trim().toLowerCase();
  const ext = normalized === 'image/jpeg' ? 'jpg' : normalized === 'image/png' ? 'png' : 'webp';
  return `tomato-photo-${datePart}-${timePart}.${ext}`;
}
