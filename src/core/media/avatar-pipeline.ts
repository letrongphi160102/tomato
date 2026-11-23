import 'server-only';

import { randomBytes } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata } from 'sharp';

export const AVATAR_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const AVATAR_MAX_INPUT_PIXELS = 25_000_000; // Chống decompression bomb (25 megapixel)
export const AVATAR_MIN_DIMENSION_PX = 16;
export const AVATAR_MAX_DIMENSION_PX = 10_000;
export const AVATAR_OUTPUT_SIZE_PX = 512;
export const AVATAR_WEBP_QUALITY = 82;

const ALLOWED_AVATAR_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ALLOWED_SHARP_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);

export type AvatarValidationErrorReason =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'DIMENSIONS_OUT_OF_RANGE'
  | 'CORRUPTED_IMAGE';

export class AvatarValidationError extends Error {
  public readonly reason: AvatarValidationErrorReason;

  constructor(reason: AvatarValidationErrorReason, message: string) {
    super(message);
    this.name = 'AvatarValidationError';
    this.reason = reason;
  }
}

export interface ProcessedAvatarResult {
  readonly buffer: Buffer;
  readonly contentType: 'image/webp';
  readonly storageKey: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

const INVALID_AVATAR_MESSAGE = 'Ảnh không hợp lệ hoặc vượt quá kích thước cho phép.';

/**
 * Pipeline xử lý ảnh đại diện an toàn bằng `file-type` + `sharp` (Node.js Runtime):
 * 1. Giới hạn kích thước đầu vào <= 10 MB.
 * 2. Đọc magic bytes: chỉ chấp nhận JPEG, PNG, WebP (cấm tuyệt đối SVG, script, file giả đuôi).
 * 3. Chống decompression bomb: giới hạn tổng pixel <= 25.000.000 và cạnh <= 10.000 px.
 * 4. Tự động xoay hướng EXIF, cắt vuông 512x512, nén WebP và xóa sạch toàn bộ EXIF/GPS/metadata.
 * 5. Sinh tên lưu trữ ngẫu nhiên 128-bit CSPRNG (`avatars/<32-hex>.webp`).
 */
export async function processAvatarImage(inputBuffer: Buffer): Promise<ProcessedAvatarResult> {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.byteLength === 0) {
    throw new AvatarValidationError('EMPTY_FILE', INVALID_AVATAR_MESSAGE);
  }

  if (inputBuffer.byteLength > AVATAR_MAX_UPLOAD_BYTES) {
    throw new AvatarValidationError('FILE_TOO_LARGE', INVALID_AVATAR_MESSAGE);
  }

  // Kiểm tra magic bytes thực tế (không tin Content-Type hay đuôi tên file từ client).
  const detected = await fileTypeFromBuffer(inputBuffer);
  if (!detected || !ALLOWED_AVATAR_MIME_TYPES.has(detected.mime)) {
    throw new AvatarValidationError('UNSUPPORTED_TYPE', INVALID_AVATAR_MESSAGE);
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(inputBuffer, {
      limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
      failOn: 'error',
      sequentialRead: true,
    }).metadata();
  } catch {
    throw new AvatarValidationError('CORRUPTED_IMAGE', INVALID_AVATAR_MESSAGE);
  }

  if (!metadata.format || !ALLOWED_SHARP_FORMATS.has(metadata.format)) {
    throw new AvatarValidationError('UNSUPPORTED_TYPE', INVALID_AVATAR_MESSAGE);
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < AVATAR_MIN_DIMENSION_PX ||
    height < AVATAR_MIN_DIMENSION_PX ||
    width > AVATAR_MAX_DIMENSION_PX ||
    height > AVATAR_MAX_DIMENSION_PX ||
    width * height > AVATAR_MAX_INPUT_PIXELS
  ) {
    throw new AvatarValidationError('DIMENSIONS_OUT_OF_RANGE', INVALID_AVATAR_MESSAGE);
  }

  try {
    // Không gọi `.keepMetadata()` / `.withMetadata()` để xóa sạch 100% EXIF, GPS, XMP, IPTC.
    const { data, info } = await sharp(inputBuffer, {
      limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
      failOn: 'error',
      sequentialRead: true,
    })
      .rotate()
      .resize(AVATAR_OUTPUT_SIZE_PX, AVATAR_OUTPUT_SIZE_PX, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: false,
      })
      .webp({ quality: AVATAR_WEBP_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    if (
      data.byteLength === 0 ||
      info.format !== 'webp' ||
      info.width !== AVATAR_OUTPUT_SIZE_PX ||
      info.height !== AVATAR_OUTPUT_SIZE_PX
    ) {
      throw new AvatarValidationError('CORRUPTED_IMAGE', INVALID_AVATAR_MESSAGE);
    }

    const storageKey = `avatars/${randomBytes(16).toString('hex')}.webp`;
    return {
      buffer: data,
      contentType: 'image/webp',
      storageKey,
      width: info.width,
      height: info.height,
      byteLength: data.byteLength,
    };
  } catch (error) {
    if (error instanceof AvatarValidationError) {
      throw error;
    }
    throw new AvatarValidationError('CORRUPTED_IMAGE', INVALID_AVATAR_MESSAGE);
  }
}
