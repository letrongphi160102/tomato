import { beforeEach, describe, expect, it } from 'vitest';

import {
  E2eeCryptoError,
  clearMemoryKeystoreForTesting,
  computeConversationSafetyNumber,
  computeDeviceKeyFingerprint,
  createPinProtectedKeyBackup,
  decryptDirectMessage,
  encryptDirectMessage,
  getBackupDeviceKeyMaterial,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
  reEncryptEditedDirectMessage,
  restorePinProtectedKeyBackup,
  sanitizeChatPlaintext,
} from '@/lib/e2ee';

describe('Unit M9: WebCrypto E2EE Engine (ECDH P-256 + HKDF + AES-256-GCM + ECDSA P-256 + PIN Backup)', () => {
  const alicePublicId = '11111111-1111-4111-8111-111111111111';
  const bobPublicId = '22222222-2222-4222-8222-222222222222';
  const conversationPublicId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(() => {
    clearMemoryKeystoreForTesting();
  });

  it('sinh cặp khóa thiết bị ECDH & ECDSA P-256 với khóa riêng non-extractable (extractable: false)', async () => {
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(alicePublicId);

    expect(aliceDevice.identityPrivateKey.extractable).toBe(false);
    expect(aliceDevice.signingPrivateKey.extractable).toBe(false);
    expect(aliceDevice.identityPublicKeyJwk.kty).toBe('EC');
    expect(aliceDevice.identityPublicKeyJwk.crv).toBe('P-256');
    expect(aliceDevice.signingPublicKeyJwk.crv).toBe('P-256');
    expect(aliceDevice.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Cố gắng export khóa riêng non-extractable phải bị WebCrypto từ chối.
    await expect(
      globalThis.crypto.subtle.exportKey('jwk', aliceDevice.identityPrivateKey),
    ).rejects.toThrow();
    await expect(
      globalThis.crypto.subtle.exportKey('jwk', aliceDevice.signingPrivateKey),
    ).rejects.toThrow();

    const expectedFp = await computeDeviceKeyFingerprint(
      aliceDevice.identityPublicKeyJwk,
      aliceDevice.signingPublicKeyJwk,
    );
    expect(aliceDevice.keyFingerprint).toBe(expectedFp);
  });

  it('mã hóa, ký ECDSA P-256, giải mã đa thiết bị và lọc sạch ký tự điều khiển RTL override', async () => {
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      alicePublicId,
      '10000000-0000-4000-8000-000000000001',
    );
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      bobPublicId,
      '20000000-0000-4000-8000-000000000002',
    );

    const clientMsgId = 'msg_unit_001';
    const rawTextWithRtlOverride = 'Xin chào Bob \u202Eevil\u202C 😊 \u2066safe\u2069';

    const envelope = await encryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      plaintext: rawTextWithRtlOverride,
      senderDevice: aliceDevice,
      recipientDevices: [
        {
          devicePublicId: bobDevice.devicePublicId,
          keyFingerprint: bobDevice.keyFingerprint,
          identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
        },
      ],
    });

    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.cryptoHeader.alg).toBe('ECDH-P256-HKDF-AES256GCM');
    expect(envelope.cryptoHeader.signature).toBeTruthy();
    expect(Object.keys(envelope.cryptoHeader.wrappedKeys)).toContain(bobDevice.keyFingerprint);
    expect(Object.keys(envelope.cryptoHeader.wrappedKeys)).toContain(aliceDevice.keyFingerprint);

    const registeredAliceDevices = [
      {
        devicePublicId: aliceDevice.devicePublicId,
        keyFingerprint: aliceDevice.keyFingerprint,
        identityPublicKeyJwk: aliceDevice.identityPublicKeyJwk,
        signingPublicKeyJwk: aliceDevice.signingPublicKeyJwk,
      },
    ];

    // Bob giải mã và xác minh chữ ký ECDSA của Alice thành công.
    const decryptedForBob = await decryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      ciphertext: envelope.ciphertext,
      cryptoHeader: envelope.cryptoHeader,
      receiverKeyMaterials: [bobDevice],
      expectedSenderDevices: registeredAliceDevices,
    });

    expect(decryptedForBob.text).toBe('Xin chào Bob evil 😊 safe');
    expect(decryptedForBob.text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(sanitizeChatPlaintext(rawTextWithRtlOverride)).toBe('Xin chào Bob evil 😊 safe');

    // Chính Alice trên thiết bị gửi cũng giải mã được lịch sử của mình.
    const decryptedForAlice = await decryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      ciphertext: envelope.ciphertext,
      cryptoHeader: envelope.cryptoHeader,
      receiverKeyMaterials: [aliceDevice],
      expectedSenderDevices: registeredAliceDevices,
    });
    expect(decryptedForAlice.text).toBe('Xin chào Bob evil 😊 safe');
  });

  it('từ chối giải mã khi AAD (conversationPublicId | senderPublicId | clientMsgId), chữ ký ECDSA hoặc ciphertext bị giả mạo', async () => {
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(alicePublicId);
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(bobPublicId);
    const malloryDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      '33333333-3333-4333-8333-333333333333',
    );

    const clientMsgId = 'msg_tamper_001';
    const envelope = await encryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      plaintext: 'Nội dung bí mật',
      senderDevice: aliceDevice,
      recipientDevices: [
        {
          devicePublicId: bobDevice.devicePublicId,
          keyFingerprint: bobDevice.keyFingerprint,
          identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
          signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
        },
      ],
    });

    // 1. Giả mạo conversationPublicId trong AAD -> chữ ký ECDSA không khớp transcript AAD.
    await expect(
      decryptDirectMessage({
        conversationPublicId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        senderPublicId: alicePublicId,
        clientMsgId,
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: [bobDevice],
      }),
    ).rejects.toThrow(E2eeCryptoError);

    // 2. Giả mạo senderPublicId trong AAD -> bị từ chối.
    await expect(
      decryptDirectMessage({
        conversationPublicId,
        senderPublicId: bobPublicId,
        clientMsgId,
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: [bobDevice],
      }),
    ).rejects.toThrow(E2eeCryptoError);

    // 3. Giả mạo clientMsgId trong AAD -> bị từ chối.
    await expect(
      decryptDirectMessage({
        conversationPublicId,
        senderPublicId: alicePublicId,
        clientMsgId: 'msg_tamper_002',
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: [bobDevice],
      }),
    ).rejects.toThrow(E2eeCryptoError);

    // 4. Sửa đổi 1 ký tự trong ciphertext -> chữ ký ECDSA bác bỏ ngay lập tức.
    const flippedChar = envelope.ciphertext.startsWith('A') ? 'B' : 'A';
    const tamperedCiphertext = `${flippedChar}${envelope.ciphertext.slice(1)}`;
    await expect(
      decryptDirectMessage({
        conversationPublicId,
        senderPublicId: alicePublicId,
        clientMsgId,
        ciphertext: tamperedCiphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: [bobDevice],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });

    // 5. Đánh tráo danh sách thiết bị đã đăng ký của người gửi bằng khóa của Mallory -> UNTRUSTED_SIGNING_KEY.
    await expect(
      decryptDirectMessage({
        conversationPublicId,
        senderPublicId: alicePublicId,
        clientMsgId,
        ciphertext: envelope.ciphertext,
        cryptoHeader: envelope.cryptoHeader,
        receiverKeyMaterials: [bobDevice],
        expectedSenderDevices: [
          {
            devicePublicId: malloryDevice.devicePublicId,
            keyFingerprint: malloryDevice.keyFingerprint,
            identityPublicKeyJwk: malloryDevice.identityPublicKeyJwk,
            signingPublicKeyJwk: malloryDevice.signingPublicKeyJwk,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_SIGNING_KEY' });
  });

  it('sao lưu & khôi phục khóa bằng Mã PIN 6 số (PBKDF2-SHA256 >= 600.000 vòng) giữ nguyên tính chất extractable: false', async () => {
    const pin = '246810';
    const created = await createPinProtectedKeyBackup({
      userPublicId: alicePublicId,
      pin,
    });

    expect(created.backup.kdfParams.alg).toBe('PBKDF2-SHA256');
    expect(created.backup.kdfParams.iterations).toBe(600_000);
    expect(created.localMaterial.identityPrivateKey.extractable).toBe(false);
    expect(created.localMaterial.signingPrivateKey.extractable).toBe(false);

    // Bob gửi tin nhắn có bọc khóa cho khóa sao lưu của Alice.
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(bobPublicId);
    const envelope = await encryptDirectMessage({
      conversationPublicId,
      senderPublicId: bobPublicId,
      clientMsgId: 'msg_for_pin_backup',
      plaintext: 'Tin nhắn đọc trên máy mới nhờ mã PIN 6 số',
      senderDevice: bobDevice,
      recipientDevices: [
        {
          devicePublicId: created.localMaterial.devicePublicId,
          keyFingerprint: created.publicRegistration.keyFingerprint,
          identityPublicKeyJwk: created.publicRegistration.identityPublicKeyJwk,
          signingPublicKeyJwk: created.publicRegistration.signingPublicKeyJwk,
        },
      ],
    });

    // Giả lập Alice đăng nhập trên trình duyệt/thiết bị mới (xóa sạch keystore cục bộ).
    clearMemoryKeystoreForTesting();
    expect(await getBackupDeviceKeyMaterial(alicePublicId)).toBeNull();

    // Nhập sai mã PIN -> giải mã thất bại.
    await expect(
      restorePinProtectedKeyBackup({
        userPublicId: alicePublicId,
        pin: '000000',
        backup: created.backup,
      }),
    ).rejects.toMatchObject({ code: 'BACKUP_DECRYPT_FAILED' });

    // Nhập đúng mã PIN -> khôi phục vào IndexedDB với extractable: false và đọc được tin nhắn cũ.
    const restored = await restorePinProtectedKeyBackup({
      userPublicId: alicePublicId,
      pin,
      backup: created.backup,
    });
    expect(restored.identityPrivateKey.extractable).toBe(false);
    expect(restored.signingPrivateKey.extractable).toBe(false);
    expect(restored.keyFingerprint).toBe(created.backup.keyFingerprint);

    const localMaterials = await listLocalDeviceKeyMaterials(alicePublicId);
    const decrypted = await decryptDirectMessage({
      conversationPublicId,
      senderPublicId: bobPublicId,
      clientMsgId: 'msg_for_pin_backup',
      ciphertext: envelope.ciphertext,
      cryptoHeader: envelope.cryptoHeader,
      receiverKeyMaterials: localMaterials,
    });
    expect(decrypted.text).toBe('Tin nhắn đọc trên máy mới nhờ mã PIN 6 số');
  });

  it('tính Mã an toàn (Safety Number) 60 chữ số đối xứng giữa 2 người dùng', async () => {
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(alicePublicId);
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(bobPublicId);

    const safetyAB = await computeConversationSafetyNumber(
      { userPublicId: alicePublicId, keyFingerprints: [aliceDevice.keyFingerprint] },
      { userPublicId: bobPublicId, keyFingerprints: [bobDevice.keyFingerprint] },
    );

    const safetyBA = await computeConversationSafetyNumber(
      { userPublicId: bobPublicId, keyFingerprints: [bobDevice.keyFingerprint] },
      { userPublicId: alicePublicId, keyFingerprints: [aliceDevice.keyFingerprint] },
    );

    expect(safetyAB.formatted).toBe(safetyBA.formatted);
    expect(safetyAB.groups).toHaveLength(12);
    expect(safetyAB.formatted).toMatch(/^(\d{5} ){11}\d{5}$/);
  });

  it('M10: reEncryptEditedDirectMessage sinh mới hoàn toàn IV 96-bit, contentKey 256-bit, chữ ký ECDSA P-256 trên cùng AAD và lọc RTL override', async () => {
    const aliceDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      alicePublicId,
      '10000000-0000-4000-8000-000000000011',
    );
    const bobDevice = await getOrCreatePrimaryDeviceKeyMaterial(
      bobPublicId,
      '20000000-0000-4000-8000-000000000022',
    );
    const clientMsgId = 'msg_m10_edit_001';
    const recipientDevices = [
      {
        devicePublicId: bobDevice.devicePublicId,
        keyFingerprint: bobDevice.keyFingerprint,
        identityPublicKeyJwk: bobDevice.identityPublicKeyJwk,
        signingPublicKeyJwk: bobDevice.signingPublicKeyJwk,
      },
    ];
    const senderDevices = [
      {
        devicePublicId: aliceDevice.devicePublicId,
        keyFingerprint: aliceDevice.keyFingerprint,
        identityPublicKeyJwk: aliceDevice.identityPublicKeyJwk,
        signingPublicKeyJwk: aliceDevice.signingPublicKeyJwk,
      },
    ];

    const original = await encryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      plaintext: 'Bản gốc trước khi sửa',
      senderDevice: aliceDevice,
      recipientDevices,
    });

    const edited = await reEncryptEditedDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      plaintext: 'Bản đã chỉnh sửa \u202Ean toàn\u202C ✨',
      senderDevice: aliceDevice,
      recipientDevices,
      previousIv: original.cryptoHeader.iv,
    });

    // Tuyệt đối không tái sử dụng IV AES-GCM, wrap IV hay chữ ký cũ.
    expect(edited.cryptoHeader.iv).not.toBe(original.cryptoHeader.iv);
    expect(edited.ciphertext).not.toBe(original.ciphertext);
    expect(edited.cryptoHeader.signature).not.toBe(original.cryptoHeader.signature);
    expect(edited.cryptoHeader.wrappedKeys[bobDevice.keyFingerprint]?.iv).not.toBe(
      original.cryptoHeader.wrappedKeys[bobDevice.keyFingerprint]?.iv,
    );

    const decryptedEdited = await decryptDirectMessage({
      conversationPublicId,
      senderPublicId: alicePublicId,
      clientMsgId,
      ciphertext: edited.ciphertext,
      cryptoHeader: edited.cryptoHeader,
      receiverKeyMaterials: [bobDevice],
      expectedSenderDevices: senderDevices,
    });
    expect(decryptedEdited.text).toBe('Bản đã chỉnh sửa an toàn ✨');
  });
});
