import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_LRU_CACHED_MEDIA_OBJECT_URLS,
  putLruMediaObjectUrlCache,
  revokeMediaObjectUrlByMessageId,
  revokeMediaObjectUrlsByConversationId,
  type DecryptedMediaObjectUrlCacheEntry,
} from '@/components/messages/chat-store-context';
import {
  getConversationPreviewText,
  IMAGE_MESSAGE_PREVIEW_LABEL,
  PIN_SYNC_REQUIRED_PREVIEW,
  VOICE_MESSAGE_PREVIEW_LABEL,
} from '@/components/messages/message-actions';
import {
  buildSafePhotoDownloadFileName,
  clearMemoryKeystoreForTesting,
  createPinProtectedKeyBackup,
  decryptDirectMessage,
  decryptMediaBinary,
  detectSupportedChatImageMime,
  E2eeCryptoError,
  encryptDirectMessage,
  encryptMediaBinary,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
  MAX_CHAT_IMAGE_INPUT_BYTES,
  MAX_CHAT_VOICE_DURATION_MS,
  MAX_CHAT_VOICE_INPUT_BYTES,
  normalizeWaveformBars,
  restorePinProtectedKeyBackup,
  sanitizeThumbnailDataUrl,
  validateVoiceBinaryInput,
  type DecryptedMessageMediaPayload,
} from '@/lib/e2ee';
import type { ChatMessageDto } from '@/modules/chat';

describe('Unit M11: WebCrypto Media Cipher (Ảnh HD & Tin nhắn thoại E2EE + Khóa Đồng bộ PIN + LRU ObjectURL)', () => {
  const alicePublicId = '11111111-1111-4111-8111-111111111111';
  const bobPublicId = '22222222-2222-4222-8222-222222222222';
  const convPublicId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const attachmentPublicId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    clearMemoryKeystoreForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mã hóa & giải mã nhị phân AES-256-GCM chính xác từng byte cho cả Ảnh HD và Tin nhắn thoại', async () => {
    const sampleImageBytes = new Uint8Array(2048);
    for (let i = 0; i < sampleImageBytes.length; i += 1) {
      sampleImageBytes[i] = (i * 31 + 17) & 0xff;
    }

    const encrypted = await encryptMediaBinary({
      plainBytes: sampleImageBytes,
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId: 'img_unit_001',
      mediaKind: 'image',
    });

    expect(encrypted.ciphertextSizeBytes).toBe(sampleImageBytes.byteLength + 16);
    expect(encrypted.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(encrypted.fileKey.length).toBeGreaterThanOrEqual(40);
    expect(encrypted.fileIv.length).toBeGreaterThanOrEqual(16);

    const decrypted = await decryptMediaBinary({
      ciphertextBytes: encrypted.ciphertextBytes,
      fileKey: encrypted.fileKey,
      fileIv: encrypted.fileIv,
      expectedSha256: encrypted.ciphertextSha256,
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId: 'img_unit_001',
      mediaKind: 'image',
    });
    expect(Array.from(decrypted)).toEqual(Array.from(sampleImageBytes));

    // Kiểm tra thêm cho voice
    const sampleVoiceBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
    const encVoice = await encryptMediaBinary({
      plainBytes: sampleVoiceBytes,
      conversationPublicId: convPublicId,
      senderPublicId: bobPublicId,
      clientMsgId: 'voc_unit_001',
      mediaKind: 'voice',
    });
    const decVoice = await decryptMediaBinary({
      ciphertextBytes: encVoice.ciphertextBytes,
      fileKey: encVoice.fileKey,
      fileIv: encVoice.fileIv,
      expectedSha256: encVoice.ciphertextSha256,
      conversationPublicId: convPublicId,
      senderPublicId: bobPublicId,
      clientMsgId: 'voc_unit_001',
      mediaKind: 'voice',
    });
    expect(Array.from(decVoice)).toEqual(Array.from(sampleVoiceBytes));
  });

  it('từ chối fail-closed khi bản mã bị sửa 1 bit (SHA-256 mismatch) hoặc sai ngữ cảnh AAD', async () => {
    const plainBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const encrypted = await encryptMediaBinary({
      plainBytes,
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId: 'img_tamper_001',
      mediaKind: 'image',
    });

    // 1. Sửa 1 bit bản mã -> phải ném MEDIA_INTEGRITY_MISMATCH trước cả khi giải mã.
    const tampered = new Uint8Array(encrypted.ciphertextBytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    await expect(
      decryptMediaBinary({
        ciphertextBytes: tampered,
        fileKey: encrypted.fileKey,
        fileIv: encrypted.fileIv,
        expectedSha256: encrypted.ciphertextSha256,
        conversationPublicId: convPublicId,
        senderPublicId: alicePublicId,
        clientMsgId: 'img_tamper_001',
        mediaKind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_INTEGRITY_MISMATCH' });

    // 2. Tráo ngữ cảnh AAD (sai conversationPublicId / clientMsgId / mediaKind) -> MEDIA_DECRYPT_FAILED.
    await expect(
      decryptMediaBinary({
        ciphertextBytes: encrypted.ciphertextBytes,
        fileKey: encrypted.fileKey,
        fileIv: encrypted.fileIv,
        expectedSha256: encrypted.ciphertextSha256,
        conversationPublicId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        senderPublicId: alicePublicId,
        clientMsgId: 'img_tamper_001',
        mediaKind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECRYPT_FAILED' });

    await expect(
      decryptMediaBinary({
        ciphertextBytes: encrypted.ciphertextBytes,
        fileKey: encrypted.fileKey,
        fileIv: encrypted.fileIv,
        expectedSha256: encrypted.ciphertextSha256,
        conversationPublicId: convPublicId,
        senderPublicId: alicePublicId,
        clientMsgId: 'img_tamper_001',
        mediaKind: 'voice',
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DECRYPT_FAILED' });
  });

  it('kiểm tra magic bytes PNG/JPEG/WebP, chặn tuyệt đối SVG ngụy trang và chặn file vượt trần dung lượng/thời lượng', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const svgDisguised = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const xmlSvg = new TextEncoder().encode('<?xml version="1.0"?><svg></svg>');

    expect(detectSupportedChatImageMime(pngBytes, 'image/png')).toBe('image/png');
    expect(detectSupportedChatImageMime(jpgBytes, 'image/jpeg')).toBe('image/jpeg');
    expect(detectSupportedChatImageMime(webpBytes, 'image/webp')).toBe('image/webp');

    expect(() => detectSupportedChatImageMime(pngBytes, 'image/svg+xml')).toThrow(E2eeCryptoError);
    expect(() => detectSupportedChatImageMime(svgDisguised, 'image/png')).toThrow(E2eeCryptoError);
    expect(() => detectSupportedChatImageMime(xmlSvg, 'image/jpeg')).toThrow(E2eeCryptoError);
    expect(() => detectSupportedChatImageMime(new Uint8Array([1, 2, 3, 4]))).toThrow(
      E2eeCryptoError,
    );

    // Ảnh vượt 10 MB bị chặn
    await expect(
      encryptMediaBinary({
        plainBytes: new Uint8Array(MAX_CHAT_IMAGE_INPUT_BYTES + 1),
        conversationPublicId: convPublicId,
        senderPublicId: alicePublicId,
        clientMsgId: 'img_oversize',
        mediaKind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });

    // Voice vượt 5 MB hoặc ngoài [500ms, 120_000ms] hoặc MIME lạ bị chặn
    expect(() =>
      validateVoiceBinaryInput({
        bytes: new Uint8Array(MAX_CHAT_VOICE_INPUT_BYTES + 1),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 5_000,
      }),
    ).toThrow(E2eeCryptoError);
    expect(() =>
      validateVoiceBinaryInput({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/webm',
        durationMs: 200,
      }),
    ).toThrow(E2eeCryptoError);
    expect(() =>
      validateVoiceBinaryInput({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/webm',
        durationMs: MAX_CHAT_VOICE_DURATION_MS + 1,
      }),
    ).toThrow(E2eeCryptoError);
    expect(() =>
      validateVoiceBinaryInput({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'application/javascript',
        durationMs: 3_000,
      }),
    ).toThrow(E2eeCryptoError);
  });

  it('bọc siêu dữ liệu `media` trong phong bì E2EE có Khóa Đồng bộ PIN -> thiết bị mới nhập PIN 6 số giải mã được nguyên vẹn ảnh/thoại', async () => {
    const aliceDevice1 = await getOrCreatePrimaryDeviceKeyMaterial(
      alicePublicId,
      '10000000-0000-4000-8000-000000000001',
    );
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      bobPublicId,
      '20000000-0000-4000-8000-000000000002',
    );

    // Alice tạo bản sao lưu mã PIN 6 số từ khóa đồng bộ.
    const createdPin = await createPinProtectedKeyBackup({
      userPublicId: alicePublicId,
      pin: '654321',
    });
    const aliceSyncTarget = {
      devicePublicId: createdPin.localMaterial.devicePublicId,
      keyFingerprint: createdPin.publicRegistration.keyFingerprint,
      isSyncKey: true,
      identityPublicKeyJwk: createdPin.publicRegistration.identityPublicKeyJwk,
      signingPublicKeyJwk: createdPin.publicRegistration.signingPublicKeyJwk,
    };

    const originalPhoto = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 12, 34, 56, 78, 0x57, 0x45, 0x42, 0x50,
    ]);
    const clientMsgId = 'img_pin_sync_001';
    const encBin = await encryptMediaBinary({
      plainBytes: originalPhoto,
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      mediaKind: 'image',
    });

    const mediaPayload: DecryptedMessageMediaPayload = {
      kind: 'image',
      attachmentPublicId,
      fileKey: encBin.fileKey,
      fileIv: encBin.fileIv,
      ciphertextSha256: encBin.ciphertextSha256,
      mimeType: 'image/webp',
      sizeBytes: originalPhoto.byteLength,
      width: 1200,
      height: 800,
      thumbnailDataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4',
    };

    const envelope = await encryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      plaintext: '',
      media: mediaPayload,
      senderDevice: aliceDevice1,
      recipientDevices: [
        {
          devicePublicId: bobDevice.devicePublicId,
          keyFingerprint: bobDevice.keyFingerprint,
          identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
        },
      ],
      senderOtherDevices: [aliceSyncTarget],
    });

    // Mô phỏng Alice chuyển sang trình duyệt hoàn toàn mới (xóa sạch RAM keystore, sinh khóa thiết bị mới).
    clearMemoryKeystoreForTesting();
    const aliceDevice2 = await getOrCreatePrimaryDeviceKeyMaterial(
      alicePublicId,
      '10000000-0000-4000-8000-000000000099',
    );
    expect(aliceDevice2.keyFingerprint).not.toBe(aliceDevice1.keyFingerprint);

    // Trước khi nhập PIN: thiết bị mới KHÔNG giải mã được phong bì media.
    await expect(
      decryptDirectMessage({
        conversationPublicId: convPublicId,
        senderPublicId: alicePublicId,
        clientMsgId,
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: await listLocalDeviceKeyMaterials(alicePublicId),
      }),
    ).rejects.toThrow(E2eeCryptoError);

    // Sau khi nhập đúng mã PIN 6 số -> khôi phục Khóa Đồng bộ -> giải mã thành công cả phong bì lẫn tệp ảnh!
    await restorePinProtectedKeyBackup({
      userPublicId: alicePublicId,
      pin: '654321',
      backup: createdPin.backup,
    });
    const decryptedEnvelope = await decryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      ciphertext: envelope.ciphertext,
      cryptoHeader: envelope.cryptoHeader,
      receiverKeyMaterials: await listLocalDeviceKeyMaterials(alicePublicId),
    });

    expect(decryptedEnvelope.media).toEqual(mediaPayload);
    const decryptedPhoto = await decryptMediaBinary({
      ciphertextBytes: encBin.ciphertextBytes,
      fileKey: decryptedEnvelope.media!.fileKey,
      fileIv: decryptedEnvelope.media!.fileIv,
      expectedSha256: decryptedEnvelope.media!.ciphertextSha256,
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      mediaKind: 'image',
    });
    expect(Array.from(decryptedPhoto)).toEqual(Array.from(originalPhoto));
  });

  it('lọc sạch thumbnail XSS/SVG, chuẩn hóa waveform 32 thanh, sinh tên file tải ảnh an toàn & giải phóng LRU ObjectURL', () => {
    expect(sanitizeThumbnailDataUrl('data:image/webp;base64,QUJDRA==')).toBe(
      'data:image/webp;base64,QUJDRA==',
    );
    expect(sanitizeThumbnailDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined();
    expect(sanitizeThumbnailDataUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeThumbnailDataUrl(`data:image/png;base64,${'A'.repeat(5000)}`)).toBeUndefined();

    const bars = normalizeWaveformBars([0.1, 0.5, 0.9, 0.3, 0.7]);
    expect(bars).toHaveLength(32);
    expect(bars.every((b) => Number.isInteger(b) && b >= 10 && b <= 100)).toBe(true);

    const fixedDate = new Date(2026, 10, 24, 9, 5, 7);
    expect(buildSafePhotoDownloadFileName('image/webp', fixedDate)).toBe(
      'tomato-photo-20261124-090507.webp',
    );
    expect(buildSafePhotoDownloadFileName('image/jpeg', fixedDate)).toBe(
      'tomato-photo-20261124-090507.jpg',
    );
    expect(buildSafePhotoDownloadFileName('image/png', fixedDate)).toBe(
      'tomato-photo-20261124-090507.png',
    );

    // Kiểm tra LRU cache ObjectURL tự revoke khi vượt ngưỡng 60 và khi xóa/thu hồi.
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const cache = new Map<string, DecryptedMediaObjectUrlCacheEntry>();

    for (let i = 0; i < MAX_LRU_CACHED_MEDIA_OBJECT_URLS + 3; i += 1) {
      putLruMediaObjectUrlCache(cache, {
        messagePublicId: `msg_${i}`,
        conversationPublicId: i % 2 === 0 ? 'conv_a' : 'conv_b',
        objectUrl: `blob:https://tomato.local/${i}`,
        mimeType: 'image/webp',
      });
    }
    expect(cache.size).toBe(MAX_LRU_CACHED_MEDIA_OBJECT_URLS);
    expect(revokeSpy).toHaveBeenCalledTimes(3);
    expect(revokeSpy).toHaveBeenCalledWith('blob:https://tomato.local/0');

    revokeMediaObjectUrlByMessageId(cache, 'msg_10');
    expect(cache.has('msg_10')).toBe(false);
    expect(revokeSpy).toHaveBeenCalledWith('blob:https://tomato.local/10');

    revokeMediaObjectUrlsByConversationId(cache, 'conv_a');
    for (const entry of cache.values()) {
      expect(entry.conversationPublicId).toBe('conv_b');
    }

    // Kiểm tra preview danh sách hội thoại cho ảnh & thoại.
    const baseDto: ChatMessageDto = {
      public_id: 'msg-preview-1',
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      isOwnMessage: true,
      seq: 1,
      clientMsgId: 'c1',
      messageType: 'image',
      ciphertext: 'x',
      cryptoHeader: null,
      editCount: 0,
      editedAt: null,
      recalledAt: null,
      createdAt: new Date().toISOString(),
    };
    expect(getConversationPreviewText(baseDto, '', false)).toBe(
      `Bạn: ${IMAGE_MESSAGE_PREVIEW_LABEL}`,
    );
    expect(
      getConversationPreviewText(
        { ...baseDto, isOwnMessage: false, messageType: 'voice' },
        '',
        false,
      ),
    ).toBe(VOICE_MESSAGE_PREVIEW_LABEL);
    expect(getConversationPreviewText(baseDto, '', true, { needsPinSync: true })).toBe(
      PIN_SYNC_REQUIRED_PREVIEW,
    );
  });
});
