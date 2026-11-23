import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMessageDecryptCacheKey,
  clearChatRamMemorySingleton,
  getOrInitUserChatRamCache,
  MAX_LRU_CACHED_CONVERSATION_THREADS,
  putLruConversationThreadCache,
  putLruDecryptedMessageCache,
  type CachedConversationThreadState,
} from '@/components/messages/chat-store-context';
import {
  buildClusteredMessageEntries,
  formatExactMessageTooltipTimeVi,
  formatMessageTimeDividerVi,
  isConversationUnread,
  shouldInsertTimeDivider,
  type GroupableMessageItem,
} from '@/components/messages/message-grouping';
import {
  clearE2eeClientBootstrapState,
  clearMemoryKeystoreForTesting,
  ensureE2eeDeviceRegisteredSingleton,
  fetchServerKeyBackupLazySingleton,
  getOrCreatePrimaryDeviceKeyMaterial,
} from '@/lib/e2ee';
import type { ChatMessageDto, ConversationSummaryDto } from '@/modules/chat';

function makeMessageItem(overrides: {
  readonly seq: number;
  readonly clientMsgId?: string;
  readonly senderPublicId?: string;
  readonly isOwnMessage?: boolean;
  readonly createdAt: string;
  readonly plaintext?: string;
  readonly sending?: boolean;
  readonly sendError?: string | null;
  readonly recalledAt?: string | null;
}): GroupableMessageItem {
  const isOwn = overrides.isOwnMessage ?? true;
  const senderId =
    overrides.senderPublicId ??
    (isOwn ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222');
  const dto: ChatMessageDto = {
    public_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(overrides.seq).padStart(12, '0')}`,
    conversationPublicId: '99999999-9999-4999-8999-999999999999',
    senderPublicId: senderId,
    isOwnMessage: isOwn,
    seq: overrides.seq,
    clientMsgId: overrides.clientMsgId ?? `msg_${overrides.seq}`,
    messageType: 'text',
    ciphertext: 'cipher',
    cryptoHeader: null,
    editCount: 0,
    editedAt: null,
    recalledAt: overrides.recalledAt ?? null,
    createdAt: overrides.createdAt,
  };

  return {
    dto,
    plaintext: overrides.plaintext ?? `Tin nhắn #${overrides.seq}`,
    decryptionFailed: false,
    sending: overrides.sending,
    sendError: overrides.sendError ?? null,
  };
}

describe('Unit: Singleton E2EE Bootstrap (Chống spam 429), Gom cụm bong bóng tin nhắn, Time Divider, Đã xem & Cache RAM LRU', () => {
  const userAPublicId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    clearMemoryKeystoreForTesting();
    clearE2eeClientBootstrapState();
    clearChatRamMemorySingleton();
  });

  afterEach(() => {
    clearMemoryKeystoreForTesting();
    clearE2eeClientBootstrapState();
    clearChatRamMemorySingleton();
    vi.restoreAllMocks();
  });

  it('Singleton E2EE Bootstrap: gọi 10 lần song song & tuần tự chỉ bắn POST /api/v1/e2ee/devices đúng 1 lần duy nhất cho mỗi (userPublicId, keyFingerprint)', async () => {
    const material = await getOrCreatePrimaryDeviceKeyMaterial(userAPublicId);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          device: {
            devicePublicId: material.devicePublicId,
            keyFingerprint: material.keyFingerprint,
          },
          message: 'Đã đồng bộ thiết bị nhắn tin.',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    // Mô phỏng React StrictMode + nhiều component gọi đồng thời khi khởi tạo trang.
    const concurrentResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureE2eeDeviceRegisteredSingleton(userAPublicId, { fetchFn: fetchMock }),
      ),
    );
    expect(concurrentResults.every(Boolean)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Mô phỏng người dùng chuyển trang qua lại nhiều lần sau đó trong cùng phiên.
    for (let i = 0; i < 4; i += 1) {
      const ok = await ensureE2eeDeviceRegisteredSingleton(userAPublicId, {
        fetchFn: fetchMock,
      });
      expect(ok).toBe(true);
    }

    // Tổng số lần gọi POST /api/v1/e2ee/devices vẫn đúng 1 lần duy nhất!
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Singleton E2EE Bootstrap & Lazy Backup: tôn trọng Retry-After khi gặp 429 (không gây vòng lặp retry) và không gọi GET /api/v1/e2ee/backup khi tài khoản chưa có backup', async () => {
    let currentTimeMs = 1_700_000_000_000;
    const now = () => currentTimeMs;

    const rateLimitedFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 'RATE_LIMITED',
            message: 'Bạn thao tác quá nhanh.',
            retryAfterSeconds: 45,
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '45',
          },
        },
      );
    });

    const firstAttempt = await ensureE2eeDeviceRegisteredSingleton(userAPublicId, {
      fetchFn: rateLimitedFetch,
      now,
    });
    expect(firstAttempt).toBe(false);
    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);

    // Gọi lại liên tiếp trong thời gian cooldown 45 giây -> bị chặn ngay tại client, KHÔNG bắn request lên server.
    currentTimeMs += 15_000;
    const secondAttempt = await ensureE2eeDeviceRegisteredSingleton(userAPublicId, {
      fetchFn: rateLimitedFetch,
      now,
    });
    expect(secondAttempt).toBe(false);
    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);

    // Kiểm tra Lazy Backup: khi `hasKeyBackupOnServer === false`, không gọi GET /api/v1/e2ee/backup.
    const backupFetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ backup: null }), { status: 200 });
    });

    const noBackupResult = await fetchServerKeyBackupLazySingleton(userAPublicId, {
      hasKeyBackupOnServer: false,
      fetchFn: backupFetchMock,
      now,
    });
    expect(noBackupResult).toBeNull();
    expect(backupFetchMock).not.toHaveBeenCalled();

    // Khi `hasKeyBackupOnServer === true` (lần đầu tiên), chỉ gọi tối đa 1 lần cho cả các lệnh gọi lặp lại.
    clearE2eeClientBootstrapState();
    const validBackupFetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          backup: {
            encryptedKeyBlob: 'a'.repeat(64),
            kdfSalt: 'b'.repeat(24),
            kdfParams: { alg: 'PBKDF2-SHA256', iterations: 600_000 },
            iv: 'c'.repeat(16),
            keyFingerprint: 'f'.repeat(64),
            version: 1,
            updatedAt: '2026-11-24T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    });

    const [b1, b2, b3] = await Promise.all([
      fetchServerKeyBackupLazySingleton(userAPublicId, {
        hasKeyBackupOnServer: true,
        fetchFn: validBackupFetchMock,
        now,
      }),
      fetchServerKeyBackupLazySingleton(userAPublicId, {
        hasKeyBackupOnServer: true,
        fetchFn: validBackupFetchMock,
        now,
      }),
      fetchServerKeyBackupLazySingleton(userAPublicId, {
        hasKeyBackupOnServer: true,
        fetchFn: validBackupFetchMock,
        now,
      }),
    ]);

    expect(b1?.keyFingerprint).toBe('f'.repeat(64));
    expect(b2?.keyFingerprint).toBe('f'.repeat(64));
    expect(b3?.keyFingerprint).toBe('f'.repeat(64));
    expect(validBackupFetchMock).toHaveBeenCalledTimes(1);
  });

  it('Gom cụm bong bóng tin nhắn (< 3 phút), chèn Time Divider (>= 15 phút / qua ngày mới) và xác định đúng tin nhắn hiển thị "Đã xem"', () => {
    const now = new Date('2026-11-24T15:00:00.000Z');
    const items: GroupableMessageItem[] = [
      // Cụm 1 của đối phương: 3 tin nhắn liên tiếp cách nhau 1 phút (< 3 phút)
      makeMessageItem({
        seq: 1,
        isOwnMessage: false,
        createdAt: '2026-11-24T10:00:00.000Z',
      }),
      makeMessageItem({
        seq: 2,
        isOwnMessage: false,
        createdAt: '2026-11-24T10:01:00.000Z',
      }),
      makeMessageItem({
        seq: 3,
        isOwnMessage: false,
        createdAt: '2026-11-24T10:02:10.000Z',
      }),
      // Cụm 2 của mình: trả lời ngay sau 30 giây (khác người gửi nên tách cụm, nhưng chưa đủ 15 phút nên không chèn Time Divider)
      makeMessageItem({
        seq: 4,
        isOwnMessage: true,
        createdAt: '2026-11-24T10:02:40.000Z',
      }),
      makeMessageItem({
        seq: 5,
        isOwnMessage: true,
        createdAt: '2026-11-24T10:03:20.000Z',
      }),
      // Cụm 3 của mình: cách tin seq=5 đúng 20 phút (>= 15 phút) -> phải có Time Divider và tách cụm mới
      makeMessageItem({
        seq: 6,
        isOwnMessage: true,
        createdAt: '2026-11-24T10:23:20.000Z',
      }),
    ];

    // Giả sử đối phương đã đọc tới seq = 5 (tin seq = 6 mới gửi chưa đọc).
    const clustered = buildClusteredMessageEntries(items, 5, now);
    expect(clustered).toHaveLength(6);

    // Tin 1, 2, 3 của đối phương tạo thành cụm: first -> middle -> last; chỉ tin 3 (last) hiện avatar đối phương.
    expect(clustered[0]?.clusterPosition).toBe('first');
    expect(clustered[0]?.showPeerAvatar).toBe(false);
    expect(clustered[0]?.timeDividerLabel).not.toBeNull(); // đầu cuộc trò chuyện luôn có Time Divider

    expect(clustered[1]?.clusterPosition).toBe('middle');
    expect(clustered[1]?.showPeerAvatar).toBe(false);
    expect(clustered[1]?.timeDividerLabel).toBeNull();

    expect(clustered[2]?.clusterPosition).toBe('last');
    expect(clustered[2]?.showPeerAvatar).toBe(true);
    expect(clustered[2]?.timeDividerLabel).toBeNull();

    // Tin 4, 5 của mình tạo thành cụm: first -> last; tin 5 là tin mới nhất có seq <= peerLastReadSeq (5) -> hiện "Đã xem".
    expect(clustered[3]?.clusterPosition).toBe('first');
    expect(clustered[3]?.timeDividerLabel).toBeNull();
    expect(clustered[3]?.isLastReadByPeer).toBe(false);

    expect(clustered[4]?.clusterPosition).toBe('last');
    expect(clustered[4]?.isLastReadByPeer).toBe(true);

    // Tin 6 cách 20 phút (>= 15 phút) -> có Time Divider, vị trí 'single', chưa được đọc (seq 6 > 5).
    expect(clustered[5]?.timeDividerLabel).not.toBeNull();
    expect(clustered[5]?.clusterPosition).toBe('single');
    expect(clustered[5]?.isLastReadByPeer).toBe(false);

    // Nếu tắt trạng thái Đã xem (peerLastReadSeq = null) -> không có tin nào hiện "Đã xem".
    const clusteredNoReceipt = buildClusteredMessageEntries(items, null, now);
    expect(clusteredNoReceipt.some((e) => e.isLastReadByPeer)).toBe(false);
  });

  it('kiểm tra định dạng Time Divider, Tooltip thời gian chi tiết, trạng thái chưa đọc và giới hạn LRU 10 hội thoại trong RAM', () => {
    expect(shouldInsertTimeDivider(null, '2026-11-24T10:00:00.000Z')).toBe(true);
    expect(shouldInsertTimeDivider('2026-11-24T10:00:00.000Z', '2026-11-24T10:14:59.000Z')).toBe(
      false,
    );
    expect(shouldInsertTimeDivider('2026-11-24T10:00:00.000Z', '2026-11-24T10:15:00.000Z')).toBe(
      true,
    );

    const tooltip = formatExactMessageTooltipTimeVi('2026-11-24T16:54:00.000Z');
    expect(tooltip).toContain('•');
    expect(tooltip).toContain('2026');

    const dividerLabel = formatMessageTimeDividerVi(
      '2026-11-20T09:15:00.000Z',
      new Date('2026-11-24T16:54:00.000Z'),
    );
    expect(dividerLabel).toContain('thg 11');

    // Kiểm tra isConversationUnread: không tính tin do chính mình gửi.
    const sampleConvBase: ConversationSummaryDto = {
      public_id: '99999999-9999-4999-8999-999999999999',
      type: 'direct',
      lastSeq: 5,
      lastMessageAt: '2026-11-24T10:00:00.000Z',
      createdAt: '2026-11-24T09:00:00.000Z',
      peer: {
        public_id: '22222222-2222-4222-8222-222222222222',
        handle: 'bob',
        fullName: 'Bob',
        avatarUrl: null,
        isPrivate: false,
      },
      myState: {
        inboxState: 'primary',
        pendingMessagesSent: 0,
        pendingMessagesRemaining: 3,
        lastReadSeq: 3,
      },
      isAwaitingPeerAcceptance: false,
      canSendMedia: true,
      canSendMoreMessages: true,
      peerLastReadSeq: 5,
      lastMessage: makeMessageItem({
        seq: 5,
        isOwnMessage: false,
        createdAt: '2026-11-24T10:00:00.000Z',
      }).dto,
    };

    expect(isConversationUnread(sampleConvBase)).toBe(true);
    expect(
      isConversationUnread({
        ...sampleConvBase,
        myState: { ...sampleConvBase.myState, lastReadSeq: 5 },
      }),
    ).toBe(false);
    expect(
      isConversationUnread({
        ...sampleConvBase,
        lastMessage: { ...sampleConvBase.lastMessage!, isOwnMessage: true },
      }),
    ).toBe(false);

    // Kiểm tra LRU eviction giới hạn đúng 10 luồng hội thoại trong RAM cache.
    const ram = getOrInitUserChatRamCache(userAPublicId);
    for (let i = 1; i <= 14; i += 1) {
      const convId = `conv-${i}`;
      const state: CachedConversationThreadState = {
        conversationPublicId: convId,
        items: [],
        nextBeforeSeq: null,
        highestSeq: i,
        hasInitialized: true,
        loadingInitial: false,
        loadingOlder: false,
        lastAccessedAt: 1000 + i,
      };
      putLruConversationThreadCache(ram.threadsByConvId, convId, state);
    }

    expect(ram.threadsByConvId.size).toBe(MAX_LRU_CACHED_CONVERSATION_THREADS);
    expect(ram.threadsByConvId.has('conv-1')).toBe(false);
    expect(ram.threadsByConvId.has('conv-4')).toBe(false);
    expect(ram.threadsByConvId.has('conv-5')).toBe(true);
    expect(ram.threadsByConvId.has('conv-14')).toBe(true);

    // Kiểm tra cache giải mã theo (public_id, editedAt, recalledAt).
    const keyV1 = buildMessageDecryptCacheKey({
      public_id: 'msg-1',
      editedAt: null,
      recalledAt: null,
    });
    const keyV2 = buildMessageDecryptCacheKey({
      public_id: 'msg-1',
      editedAt: '2026-11-24T10:05:00.000Z',
      recalledAt: null,
    });
    expect(keyV1).not.toBe(keyV2);
    putLruDecryptedMessageCache(ram.decryptedMessagesByCacheKey, keyV1, {
      plaintext: 'Bản gốc',
      decryptionFailed: false,
    });
    expect(ram.decryptedMessagesByCacheKey.get(keyV1)?.plaintext).toBe('Bản gốc');

    // Khi xóa sạch RAM cache lúc đăng xuất -> không còn bất kỳ dữ liệu nào.
    clearChatRamMemorySingleton();
    const freshRam = getOrInitUserChatRamCache(userAPublicId);
    expect(freshRam.threadsByConvId.size).toBe(0);
    expect(freshRam.decryptedMessagesByCacheKey.size).toBe(0);
  });
});
