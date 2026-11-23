import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { describe, expect, it } from 'vitest';

import {
  AVATAR_MAX_UPLOAD_BYTES,
  AVATAR_OUTPUT_SIZE_PX,
  AvatarValidationError,
  processAvatarImage,
} from '@/core/media';
import { AVATAR_STORAGE_KEY_REGEX } from '@/core/storage';

async function createSampleImage(
  format: 'png' | 'jpeg' | 'webp',
  width = 800,
  height = 600,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 60, b: 50 },
    },
  });

  if (format === 'png') {
    return base.png().toBuffer();
  }
  if (format === 'jpeg') {
    return base.jpeg({ quality: 90 }).toBuffer();
  }
  return base.webp({ quality: 90 }).toBuffer();
}

describe('Unit M6: Pipeline xử lý ảnh đại diện (file-type + sharp)', () => {
  it('chấp nhận JPEG, PNG, WebP hợp lệ và nén lại thành WebP vuông 512x512 tên ngẫu nhiên', async () => {
    for (const fmt of ['jpeg', 'png', 'webp'] as const) {
      const source = await createSampleImage(fmt, 640, 480);
      const result = await processAvatarImage(source);

      expect(result.contentType).toBe('image/webp');
      expect(result.width).toBe(AVATAR_OUTPUT_SIZE_PX);
      expect(result.height).toBe(AVATAR_OUTPUT_SIZE_PX);
      expect(result.storageKey).toMatch(AVATAR_STORAGE_KEY_REGEX);
      expect(result.byteLength).toBe(result.buffer.byteLength);

      const detectedOut = await fileTypeFromBuffer(result.buffer);
      expect(detectedOut?.mime).toBe('image/webp');
    }
  });

  it('tự xoay hướng EXIF và xóa sạch hoàn toàn EXIF/GPS/metadata nhạy cảm khỏi ảnh đầu ra', async () => {
    const withExif = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 3,
        background: { r: 30, g: 120, b: 200 },
      },
    })
      .withExif({
        IFD0: {
          Make: 'TomatoCamera',
          Model: 'SecretPhone',
          Orientation: '6',
          ImageDescription: 'GPS-SECRET-LOCATION-COORDS',
        },
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    const inputMeta = await sharp(withExif).metadata();
    expect(inputMeta.exif).toBeDefined();

    const processed = await processAvatarImage(withExif);
    const outputMeta = await sharp(processed.buffer).metadata();
    expect(outputMeta.format).toBe('webp');
    expect(outputMeta.width).toBe(512);
    expect(outputMeta.height).toBe(512);
    expect(outputMeta.exif).toBeUndefined();
    expect(outputMeta.xmp).toBeUndefined();
    expect(outputMeta.iptc).toBeUndefined();
    expect(processed.buffer.includes(Buffer.from('GPS-SECRET-LOCATION-COORDS'))).toBe(false);
    expect(processed.buffer.includes(Buffer.from('TomatoCamera'))).toBe(false);
  });

  it('chặn tuyệt đối tệp SVG, HTML/script, ZIP, PDF hoặc tệp giả mạo đuôi ảnh', async () => {
    const svgPayload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="100" height="100"/></svg>',
      'utf8',
    );
    const htmlPayload = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
    // Header ZIP PK\x03\x04
    const zipPayload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    // Header PDF %PDF-1.7
    const pdfPayload = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'utf8');
    // Header GIF89a (không nằm trong allowlist JPEG/PNG/WebP)
    const gifPayload = Buffer.from(
      'GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;',
      'binary',
    );

    for (const payload of [svgPayload, htmlPayload, zipPayload, pdfPayload, gifPayload]) {
      await expect(processAvatarImage(payload)).rejects.toThrow(AvatarValidationError);
    }

    await expect(processAvatarImage(Buffer.alloc(0))).rejects.toThrow(AvatarValidationError);
  });

  it('chặn tệp vượt quá 10 MB và ảnh decompression bomb vượt 25 triệu pixel', async () => {
    const oversized = Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1, 0xff);
    await expect(processAvatarImage(oversized)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      reason: 'FILE_TOO_LARGE',
    });

    // Tạo một ảnh PNG hợp lệ nhưng có chiều 6000x6000 = 36.000.000 pixel (> 25.000.000 pixel).
    const pixelBomb = await sharp({
      create: {
        width: 6000,
        height: 6000,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    expect(pixelBomb.byteLength).toBeLessThan(AVATAR_MAX_UPLOAD_BYTES);
    await expect(processAvatarImage(pixelBomb)).rejects.toThrow(AvatarValidationError);
  });
});
