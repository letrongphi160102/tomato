import { afterEach, describe, expect, it } from 'vitest';

import {
  computeHighestVisibleMessageSeq,
  resolvePinSyncState,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import {
  getConversationPreviewText,
  PIN_SYNC_REQUIRED_PREVIEW,
  UNAVAILABLE_OLD_MESSAGE_PREVIEW,
} from '@/components/messages/message-actions';
import { buildProfileShareUrl } from '@/lib/profile-share';
import { hashScopedOtpCode, maskEmailAddress, verifyScopedOtpCode } from '@/core/crypto/otp';
import { REDACT_PATHS } from '@/core/logger';
import { scrubSentryEvent } from '@/core/monitoring/sentry-scrub';
import { InMemoryPinResetOtpStore } from '@/core/redis';
import {
  clearMemoryKeystoreForTesting,
  createPinProtectedKeyBackup,
  decryptDirectMessage,
  encryptDirectMessage,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
  reEncryptEditedDirectMessage,
  reEncryptPinProtectedKeyBackup,
  restorePinProtectedKeyBackup,
  saveDeviceKeyMaterial,
  type E2eeTargetDevicePublicKey,
} from '@/lib/e2ee';
import type { ChatMessageDto, UserE2eeKeyBundleDto } from '@/modules/chat';

const TEST_OTP_SECRET = 'synthetic-unit-test-otp-secret-key-32-chars-minimum';

function makeDummyDeviceKey(seed: number, isSyncKey = false): E2eeTargetDevicePublicKey {
  const hex = seed.toString(16).padStart(64, '0');
  return {
    devicePublicId: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`,
    keyFingerprint: hex,
    isSyncKey,
    // Tạo tọa độ P-256 hợp lệ từ cặp khóa sinh thật ở helper bên dưới khi cần mã hóa thật.
    identityPublicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    signingPublicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
}

async function generateRealTargetDevice(
  userPublicId: string,
  isSyncKey = false,
): Promise<E2eeTargetDevicePublicKey> {
  clearMemoryKeystoreForTesting();
  const mat = await getOrCreatePrimaryDeviceKeyMaterial(userPublicId);
  return {
    devicePublicId: mat.devicePublicId,
    keyFingerprint: mat.keyFingerprint,
    isSyncKey,
    identityPublicKeyJwk: mat.identityPublicKeyJwk,
    signingPublicKeyJwk: mat.signingPublicKeyJwk,
  };
}

function makeMessageItem(
  overrides: Partial<DecryptedMessageViewItem> & { seq: number },
): DecryptedMessageViewItem {
  const dto: ChatMessageDto = {
    public_id: `11111111-1111-4111-8111-${String(overrides.seq).padStart(12, '0')}`,
    conversationPublicId: '22222222-2222-4222-8222-222222222222',
    senderPublicId: '33333333-3333-4333-8333-333333333333',
    isOwnMessage: false,
    seq: overrides.seq,
    clientMsgId: `msg_${overrides.seq}`,
    messageType: 'text',
    ciphertext: 'cipher',
    cryptoHeader: null,
    editCount: 0,
    editedAt: null,
    recalledAt: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    ...(overrides.dto ?? {}),
  };
  return {
    dto,
    plaintext: overrides.plaintext ?? 'Xin chào',
    decryptionFailed: overrides.decryptionFailed ?? false,
    sending: overrides.sending,
    sendError: overrides.sendError,
  };
}

afterEach(() => {
  clearMemoryKeystoreForTesting();
});

describe('Unit: Chia sẻ trang cá nhân, OTP Redis & Che dữ liệu nhạy cảm', () => {
  it('tạo URL chia sẻ trang cá nhân chuẩn và mã hóa handle an toàn', () => {
    expect(buildProfileShareUrl('https://tomato.app/', 'lam_nguyen')).toBe(
      'https://tomato.app/u/lam_nguyen',
    );
    expect(buildProfileShareUrl('http://localhost:3000', 'a.b_1')).toBe(
      'http://localhost:3000/u/a.b_1',
    );
  });

  it('che địa chỉ email an toàn và băm/xác minh OTP theo ngữ cảnh riêng biệt', () => {
    expect(maskEmailAddress('lam.nguyen@gmail.com')).toBe('l***@gmail.com');
    expect(maskEmailAddress('a@tomato.vn')).toBe('a***@tomato.vn');

    const hash = hashScopedOtpCode(
      '482910',
      { userId: 'user-a', scope: 'e2ee_pin_reset' },
      TEST_OTP_SECRET,
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyScopedOtpCode(
        '482910',
        hash,
        { userId: 'user-a', scope: 'e2ee_pin_reset' },
        TEST_OTP_SECRET,
      ),
    ).toBe(true);
    expect(
      verifyScopedOtpCode(
        '482910',
        hash,
        { userId: 'user-b', scope: 'e2ee_pin_reset' },
        TEST_OTP_SECRET,
      ),
    ).toBe(false);
    expect(
      verifyScopedOtpCode(
        '000000',
        hash,
        { userId: 'user-a', scope: 'e2ee_pin_reset' },
        TEST_OTP_SECRET,
      ),
    ).toBe(false);
  });

  it('InMemoryPinResetOtpStore: TTL hết hạn, hủy sau 5 lần sai và CAS+DEL chặn dùng lại lần 2', async () => {
    let clockMs = 1_700_000_000_000;
    const store = new InMemoryPinResetOtpStore({ now: () => clockMs });
    const hash = 'a'.repeat(64);

    await store.issueOtp('user-1', hash, 600);
    expect(await store.getOtpRecord('user-1')).toEqual({ otpHashHex: hash, attempts: 0 });

    // 4 lần sai -> giảm dần lượt còn lại; lần thứ 5 -> tự hủy OTP.
    for (let i = 1; i <= 4; i += 1) {
      const outcome = await store.recordFailedAttempt('user-1', hash, 5);
      expect(outcome).toEqual({ exhausted: false, remainingAttempts: 5 - i });
    }
    const fifth = await store.recordFailedAttempt('user-1', hash, 5);
    expect(fifth).toEqual({ exhausted: true, remainingAttempts: 0 });
    expect(await store.getOtpRecord('user-1')).toBeNull();

    // Cấp lại và kiểm tra CAS+DEL dùng 1 lần duy nhất.
    await store.issueOtp('user-1', hash, 600);
    expect(await store.consumeOtpIfMatches('user-1', hash)).toBe(true);
    expect(await store.consumeOtpIfMatches('user-1', hash)).toBe(false);

    // Kiểm tra TTL hết hạn.
    await store.issueOtp('user-1', hash, 600);
    clockMs += 601_000;
    expect(await store.getOtpRecord('user-1')).toBeNull();
  });

  it('Pino REDACT_PATHS và Sentry scrubSentryEvent che sạch otpCode, otp_code, currentPin, newPin', () => {
    expect(REDACT_PATHS).toContain('otpCode');
    expect(REDACT_PATHS).toContain('otp_code');
    expect(REDACT_PATHS).toContain('currentPin');
    expect(REDACT_PATHS).toContain('newPin');

    const scrubbed = scrubSentryEvent({
      type: undefined,
      message: 'Body {"otpCode":"123456","currentPin":"111111","newPin":"222222"}',
      extra: {
        otpCode: '123456',
        otp_code: '123456',
        currentPin: '111111',
        newPin: '222222',
      },
    } as Parameters<typeof scrubSentryEvent>[0]);

    expect(scrubbed.message).not.toContain('123456');
    expect(scrubbed.message).not.toContain('111111');
    expect(scrubbed.message).not.toContain('222222');
    expect(scrubbed.extra).toEqual({
      otpCode: '[REDACTED]',
      otp_code: '[REDACTED]',
      currentPin: '[REDACTED]',
      newPin: '[REDACTED]',
    });
  });
});

describe('Unit: Vòng đời Mã PIN 6 số, ưu tiên bọc Khóa Đồng bộ & Bảo toàn Đã xem', () => {
  const aliceId = '11111111-1111-4111-8111-111111111111';
  const bobId = '22222222-2222-4222-8222-222222222222';
  const convId = '33333333-3333-4333-8333-333333333333';

  it('ưu tiên bọc khóa cho senderDevice và Khóa Đồng bộ của cả 2 phía ngay cả khi vượt ngưỡng 20 thiết bị', async () => {
    const recipientDevices: E2eeTargetDevicePublicKey[] = [];
    const senderOtherDevices: E2eeTargetDevicePublicKey[] = [];

    // 12 thiết bị thường cho mỗi phía + 1 Khóa Đồng bộ đặt ở cuối mảng.
    for (let i = 0; i < 12; i += 1) {
      recipientDevices.push(await generateRealTargetDevice(`bob-dev-${i}`, false));
      senderOtherDevices.push(await generateRealTargetDevice(`alice-dev-${i}`, false));
    }
    const bobSyncKey = await generateRealTargetDevice('bob-sync', true);
    const aliceSyncKey = await generateRealTargetDevice('alice-sync', true);
    recipientDevices.push(bobSyncKey);
    senderOtherDevices.push(aliceSyncKey);

    clearMemoryKeystoreForTesting();
    const senderPrimary = await getOrCreatePrimaryDeviceKeyMaterial(aliceId);

    const envelope = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_priority_wrap_1',
      plaintext: 'Tin nhắn quan trọng cần đồng bộ đa thiết bị',
      senderDevice: senderPrimary,
      recipientDevices,
      senderOtherDevices,
    });

    const wrappedKeys = Object.keys(envelope.cryptoHeader.wrappedKeys);
    expect(wrappedKeys.length).toBeLessThanOrEqual(20);
    expect(wrappedKeys).toContain(senderPrimary.keyFingerprint);
    expect(wrappedKeys).toContain(bobSyncKey.keyFingerprint);
    expect(wrappedKeys).toContain(aliceSyncKey.keyFingerprint);
  });

  it('Đổi mã PIN giữ nguyên cặp khóa gốc: sai PIN cũ bị chặn, trình duyệt mới nhập PIN mới giải mã 100% tin nhắn cũ', async () => {
    const aliceBackup1 = await createPinProtectedKeyBackup({
      userPublicId: aliceId,
      pin: '123456',
      persistLocally: true,
    });
    const alicePrimaryA = await getOrCreatePrimaryDeviceKeyMaterial(aliceId);

    const bobSync = await createPinProtectedKeyBackup({
      userPublicId: bobId,
      pin: '654321',
      persistLocally: false,
    });

    const aliceSyncTarget: E2eeTargetDevicePublicKey = {
      devicePublicId: aliceBackup1.localMaterial.devicePublicId,
      keyFingerprint: aliceBackup1.publicRegistration.keyFingerprint,
      isSyncKey: true,
      identityPublicKeyJwk: aliceBackup1.publicRegistration.identityPublicKeyJwk,
      signingPublicKeyJwk: aliceBackup1.publicRegistration.signingPublicKeyJwk,
    };
    const bobSyncTarget: E2eeTargetDevicePublicKey = {
      devicePublicId: bobSync.localMaterial.devicePublicId,
      keyFingerprint: bobSync.publicRegistration.keyFingerprint,
      isSyncKey: true,
      identityPublicKeyJwk: bobSync.publicRegistration.identityPublicKeyJwk,
      signingPublicKeyJwk: bobSync.publicRegistration.signingPublicKeyJwk,
    };

    // Gửi 1 tin nhắn gốc (M9) và 1 tin đã chỉnh sửa (M10) TRƯỚC khi đổi PIN.
    const msg1 = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_before_pin_change_1',
      plaintext: 'Tin nhắn gửi trước khi đổi mã PIN',
      senderDevice: alicePrimaryA,
      recipientDevices: [bobSyncTarget],
      senderOtherDevices: [aliceSyncTarget],
    });
    const msg1Edited = await reEncryptEditedDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_before_pin_change_1',
      plaintext: 'Tin nhắn đã chỉnh sửa trước khi đổi mã PIN',
      senderDevice: alicePrimaryA,
      recipientDevices: [bobSyncTarget],
      senderOtherDevices: [aliceSyncTarget],
      previousIv: msg1.cryptoHeader.iv,
    });

    // Sai PIN cũ -> bị từ chối rõ ràng.
    await expect(
      reEncryptPinProtectedKeyBackup({
        userPublicId: aliceId,
        currentPin: '999999',
        newPin: '246810',
        backup: aliceBackup1.backup,
        persistLocally: false,
      }),
    ).rejects.toThrow('Mã PIN hiện tại không đúng.');

    // PIN mới trùng PIN cũ -> bị từ chối.
    await expect(
      reEncryptPinProtectedKeyBackup({
        userPublicId: aliceId,
        currentPin: '123456',
        newPin: '123456',
        backup: aliceBackup1.backup,
        persistLocally: false,
      }),
    ).rejects.toThrow('Mã PIN mới phải khác mã PIN hiện tại.');

    // Đúng PIN cũ -> đổi sang PIN mới `246810`, giữ nguyên keyFingerprint nhưng đổi kdfSalt & iv mới.
    const changed = await reEncryptPinProtectedKeyBackup({
      userPublicId: aliceId,
      currentPin: '123456',
      newPin: '246810',
      backup: aliceBackup1.backup,
      persistLocally: false,
    });
    expect(changed.backup.keyFingerprint).toBe(aliceBackup1.backup.keyFingerprint);
    expect(changed.backup.kdfSalt).not.toBe(aliceBackup1.backup.kdfSalt);
    expect(changed.backup.iv).not.toBe(aliceBackup1.backup.iv);
    expect(changed.backup.version).toBe(2);

    // Mô phỏng Trình duyệt B hoàn toàn mới (IndexedDB rỗng):
    clearMemoryKeystoreForTesting();
    const browserBPrimary = await getOrCreatePrimaryDeviceKeyMaterial(aliceId);
    // Trước khi nhập PIN: tin cũ không giải mã được.
    await expect(
      decryptDirectMessage({
        conversationPublicId: convId,
        senderPublicId: aliceId,
        clientMsgId: 'msg_before_pin_change_1',
        ciphertext: msg1Edited.ciphertext,
        cryptoHeader: msg1Edited.cryptoHeader,
        receiverKeyMaterials: await listLocalDeviceKeyMaterials(aliceId),
      }),
    ).rejects.toThrow();

    // Nhưng trình duyệt B vẫn gửi được tin mới bọc kèm Khóa Đồng bộ.
    const newMsgFromB = await encryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_from_browser_b_before_pin',
      plaintext: 'Tin mới gửi khi chưa nhập mã PIN',
      senderDevice: browserBPrimary,
      recipientDevices: [bobSyncTarget],
      senderOtherDevices: [aliceSyncTarget],
    });

    // Nhập mã PIN mới `246810` trên trình duyệt B -> giải mã 100% tin cũ + tin sửa + tin mới!
    const restored = await restorePinProtectedKeyBackup({
      userPublicId: aliceId,
      pin: '246810',
      backup: changed.backup,
    });
    await saveDeviceKeyMaterial(restored, 'backup');

    const localMaterials = await listLocalDeviceKeyMaterials(aliceId);
    const decOld = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_before_pin_change_1',
      ciphertext: msg1.ciphertext,
      cryptoHeader: msg1.cryptoHeader,
      receiverKeyMaterials: localMaterials,
    });
    const decEdited = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_before_pin_change_1',
      ciphertext: msg1Edited.ciphertext,
      cryptoHeader: msg1Edited.cryptoHeader,
      receiverKeyMaterials: localMaterials,
    });
    const decNew = await decryptDirectMessage({
      conversationPublicId: convId,
      senderPublicId: aliceId,
      clientMsgId: 'msg_from_browser_b_before_pin',
      ciphertext: newMsgFromB.ciphertext,
      cryptoHeader: newMsgFromB.cryptoHeader,
      receiverKeyMaterials: localMaterials,
    });

    expect(decOld.text).toBe('Tin nhắn gửi trước khi đổi mã PIN');
    expect(decEdited.text).toBe('Tin nhắn đã chỉnh sửa trước khi đổi mã PIN');
    expect(decNew.text).toBe('Tin mới gửi khi chưa nhập mã PIN');
  });

  it('bảo toàn logic Đã xem cho tin bị ẩn chờ PIN & không lặp đòi PIN khi trạng thái đã synced sau đặt lại', () => {
    const items = [
      makeMessageItem({ seq: 1, decryptionFailed: true }),
      makeMessageItem({ seq: 2, decryptionFailed: true }),
      makeMessageItem({
        seq: 3,
        decryptionFailed: false,
        plaintext: 'Tin mới gửi trên thiết bị này',
      }),
      makeMessageItem({ seq: 4, decryptionFailed: false, sending: true, plaintext: 'Đang gửi' }),
    ];

    // Chỉ tính seq lớn nhất của tin thực sự hiển thị được (seq = 3).
    expect(computeHighestVisibleMessageSeq(items)).toBe(3);

    // Nếu toàn bộ tin trong đoạn chat đều đang bị ẩn chờ nhập PIN -> trả 0 (TUYỆT ĐỐI không gửi POST .../read).
    const allLocked = [
      makeMessageItem({ seq: 5, decryptionFailed: true }),
      makeMessageItem({ seq: 6, decryptionFailed: true }),
    ];
    expect(computeHighestVisibleMessageSeq(allLocked)).toBe(0);

    // Kiểm tra trạng thái đồng bộ PIN và preview không gây vòng lặp sau khi đã reset PIN.
    const noBackupBundle: UserE2eeKeyBundleDto = {
      userPublicId: aliceId,
      devices: [],
      hasKeyBackup: false,
      backupKeyFingerprint: null,
    };
    const withBackupBundle: UserE2eeKeyBundleDto = {
      userPublicId: aliceId,
      devices: [
        {
          ...makeDummyDeviceKey(1, true),
          deviceLabel: 'Khóa đồng bộ tin nhắn',
          isSyncKey: true,
          createdAt: '2026-11-24T10:00:00.000Z',
          lastSeenAt: '2026-11-24T10:00:00.000Z',
        },
      ],
      hasKeyBackup: true,
      backupKeyFingerprint: '0'.repeat(63) + '1',
    };

    expect(resolvePinSyncState(null, false)).toBe('loading');
    expect(resolvePinSyncState(noBackupBundle, false)).toBe('must_create');
    expect(resolvePinSyncState(withBackupBundle, false)).toBe('needs_restore');
    expect(resolvePinSyncState(withBackupBundle, true)).toBe('synced');

    const lockedDto = allLocked[0]!.dto;
    expect(getConversationPreviewText(lockedDto, '', true, { needsPinSync: true })).toBe(
      PIN_SYNC_REQUIRED_PREVIEW,
    );
    expect(getConversationPreviewText(lockedDto, '', true, { needsPinSync: false })).toBe(
      UNAVAILABLE_OLD_MESSAGE_PREVIEW,
    );
  });
});
