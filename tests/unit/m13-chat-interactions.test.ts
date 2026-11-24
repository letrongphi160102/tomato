import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildReplyPayloadFromMessage,
  canCopyMessage,
  canForwardMessage,
  canPinMessage,
  canReactToMessage,
  canReplyToMessage,
  getPinnedMessagePreviewText,
  PINNED_MESSAGE_NEEDS_PIN_LABEL,
} from '@/components/messages/message-actions';
import {
  formatMessageMenuTimestampVi,
  isConversationUnread,
  isConversationUnreadForBadge,
  sortPrimaryConversationsWithPins,
  type GroupableMessageItem,
} from '@/components/messages/message-grouping';
import { generatePublicId } from '@/core/crypto/id';
import { assertRealtimePayloadSafe } from '@/core/realtime';
import {
  isValidSingleReactionEmoji,
  normalizeAndValidateSingleEmoji,
  QUICK_REACTION_EMOJIS,
} from '@/lib/chat/emoji';
import {
  decryptDirectMessage,
  encryptDirectMessage,
  MAX_REPLY_EXCERPT_LENGTH,
  sanitizeReplyTextExcerpt,
} from '@/lib/e2ee/cipher';
import {
  clearMemoryKeystoreForTesting,
  getOrCreatePrimaryDeviceKeyMaterial,
} from '@/lib/e2ee/keystore';
import type { ChatMessageDto, ConversationSummaryDto } from '@/modules/chat';

function makeConv(overrides: Partial<ConversationSummaryDto> = {}): ConversationSummaryDto {
  const now = '2026-11-24T12:00:00.000Z';
  const baseMessage: ChatMessageDto = {
    public_id: generatePublicId(),
    conversationPublicId: generatePublicId(),
    senderPublicId: generatePublicId(),
    isOwnMessage: false,
    seq: 2,
    clientMsgId: 'msg_1',
    messageType: 'text',
    ciphertext: 'abc',
    cryptoHeader: null,
    editCount: 0,
    editedAt: null,
    recalledAt: null,
    createdAt: now,
  };
  return {
    public_id: generatePublicId(),
    type: 'direct',
    lastSeq: 2,
    lastMessageAt: now,
    createdAt: now,
    peer: {
      public_id: generatePublicId(),
      handle: 'peer_user',
      fullName: 'Peer User',
      avatarUrl: null,
      isPrivate: false,
    },
    myState: {
      inboxState: 'primary',
      pendingMessagesSent: 0,
      pendingMessagesRemaining: 3,
      lastReadSeq: 0,
      clearedBeforeSeq: 0,
      pinnedAt: null,
      mutedAt: null,
      isPinned: false,
      isMuted: false,
    },
    isAwaitingPeerAcceptance: false,
    canSendMedia: true,
    canSendMoreMessages: true,
    peerLastReadSeq: null,
    lastMessage: baseMessage,
    ...overrides,
  };
}

function makeMessageItem(overrides: Partial<GroupableMessageItem> = {}): GroupableMessageItem {
  const dto: ChatMessageDto = {
    public_id: generatePublicId(),
    conversationPublicId: generatePublicId(),
    senderPublicId: generatePublicId(),
    isOwnMessage: true,
    seq: 1,
    clientMsgId: 'msg_1',
    messageType: 'text',
    ciphertext: 'cipher',
    cryptoHeader: null,
    editCount: 0,
    editedAt: null,
    recalledAt: null,
    createdAt: '2026-11-24T12:00:00.000Z',
  };
  return {
    dto,
    plaintext: 'Xin chào Tomato',
    decryptionFailed: false,
    ...overrides,
  };
}

describe('M13 Unit Tests — Emoji grapheme validator, E2EE reply/forward, Realtime guard & UI rules', () => {
  it('xác thực chính xác 1 cụm biểu tượng cảm xúc bằng Intl.Segmenter (chấp nhận ZWJ/cờ/màu da, chặn ASCII/HTML/BiDi)', () => {
    for (const quick of QUICK_REACTION_EMOJIS) {
      expect(isValidSingleReactionEmoji(quick)).toBe(true);
      expect(normalizeAndValidateSingleEmoji(quick)).toBe(quick);
    }

    // Chấp nhận tổ hợp phức hợp: cờ quốc gia, tông màu da, gia đình ZWJ, keycap.
    expect(isValidSingleReactionEmoji('🇻🇳')).toBe(true);
    expect(isValidSingleReactionEmoji('👍🏽')).toBe(true);
    expect(isValidSingleReactionEmoji('👨‍👩‍👧‍👦')).toBe(true);
    expect(isValidSingleReactionEmoji('1️⃣')).toBe(true);

    // Chặn chuỗi rỗng, ASCII chữ/số, HTML/XSS, BiDi override, và nhiều hơn 1 emoji.
    expect(normalizeAndValidateSingleEmoji('')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('   ')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('a')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('1')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('abc')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('<script>')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('❤️❤️')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('❤️ 😂')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('❤️\u202E')).toBeNull();
    expect(normalizeAndValidateSingleEmoji('\u2066😂\u2069')).toBeNull();
  });

  it('lọc sạch BiDi override & cắt cứng trích dẫn trả lời <= 140 code points ở cả mã hóa lẫn giải mã E2EE', async () => {
    clearMemoryKeystoreForTesting();
    const convPublicId = generatePublicId();
    const alicePublicId = generatePublicId();
    const bobPublicId = generatePublicId();
    const replyTargetPublicId = generatePublicId();

    const aliceKey = await getOrCreatePrimaryDeviceKeyMaterial(alicePublicId);
    const bobKey = await getOrCreatePrimaryDeviceKeyMaterial(bobPublicId);

    const maliciousExcerpt = `\u202E${'Xin chào 😊 '.repeat(30)}\u202C\u2066`;
    const cleanedExcerpt = sanitizeReplyTextExcerpt(maliciousExcerpt);
    expect(cleanedExcerpt).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/);
    expect(Array.from(cleanedExcerpt).length).toBeLessThanOrEqual(MAX_REPLY_EXCERPT_LENGTH);

    const envelope = await encryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId: 'msg_m13_reply_1',
      plaintext: 'Đây là tin nhắn trả lời',
      replyTo: {
        messagePublicId: replyTargetPublicId,
        senderPublicId: bobPublicId,
        messageType: 'text',
        textExcerpt: maliciousExcerpt,
      },
      forwarded: true,
      senderDevice: aliceKey,
      recipientDevices: [
        {
          devicePublicId: bobKey.devicePublicId,
          keyFingerprint: bobKey.keyFingerprint,
          identityPublicKeyJwk: bobKey.identityPublicKeyJwk,
          signingPublicKeyJwk: bobKey.signingPublicKeyJwk,
        },
      ],
    });

    const decrypted = await decryptDirectMessage({
      conversationPublicId: convPublicId,
      senderPublicId: alicePublicId,
      clientMsgId: 'msg_m13_reply_1',
      ciphertext: envelope.ciphertext,
      cryptoHeader: envelope.cryptoHeader,
      receiverKeyMaterials: [bobKey],
    });

    expect(decrypted.text).toBe('Đây là tin nhắn trả lời');
    expect(decrypted.forwarded).toBe(true);
    expect(decrypted.replyTo).toBeDefined();
    expect(decrypted.replyTo?.messagePublicId).toBe(replyTargetPublicId);
    expect(decrypted.replyTo?.textExcerpt).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(Array.from(decrypted.replyTo?.textExcerpt ?? '').length).toBeLessThanOrEqual(
      MAX_REPLY_EXCERPT_LENGTH,
    );
  });

  it('assertRealtimePayloadSafe cho qua trơn tru cả 3 sự kiện Realtime M13 và chặn rò rỉ id/plaintext/ciphertext', () => {
    const convId = generatePublicId();
    const msgId = generatePublicId();
    const actorId = generatePublicId();

    expect(() =>
      assertRealtimePayloadSafe({
        conversationPublicId: convId,
        messagePublicId: msgId,
        seq: 12,
        actorPublicId: actorId,
        emoji: '❤️',
        updatedAt: '2026-11-24T12:00:00.000Z',
      }),
    ).not.toThrow();

    expect(() =>
      assertRealtimePayloadSafe({
        conversationPublicId: convId,
        messagePublicId: msgId,
        pinned: true,
        actorPublicId: actorId,
        updatedAt: '2026-11-24T12:00:00.000Z',
      }),
    ).not.toThrow();

    expect(() =>
      assertRealtimePayloadSafe({
        conversationPublicId: convId,
        pinnedAt: '2026-11-24T12:00:00.000Z',
        mutedAt: null,
        isPinned: true,
        isMuted: false,
        unreadConversationsCount: 2,
        updatedAt: '2026-11-24T12:00:00.000Z',
      }),
    ).not.toThrow();

    // Chặn rò rỉ khóa nội bộ / plaintext / ciphertext trong sự kiện M13.
    expect(() =>
      assertRealtimePayloadSafe({
        id: 'internal-uuid',
        conversationPublicId: convId,
        emoji: '❤️',
      }),
    ).toThrow();
    expect(() =>
      assertRealtimePayloadSafe({
        conversationPublicId: convId,
        plaintext: 'bí mật',
      }),
    ).toThrow();
    expect(() =>
      assertRealtimePayloadSafe({
        conversationPublicId: convId,
        ciphertext: 'secret-cipher',
      }),
    ).toThrow();
  });

  it('sắp xếp đúng đoạn chat đã ghim lên đầu & loại trừ đoạn chat đã tắt thông báo khỏi badge đỏ', () => {
    const unpinnedNewest = makeConv({
      public_id: 'c-unpinned-new',
      lastMessageAt: '2026-11-24T15:00:00.000Z',
      myState: {
        inboxState: 'primary',
        pendingMessagesSent: 0,
        pendingMessagesRemaining: 3,
        lastReadSeq: 0,
        pinnedAt: null,
        mutedAt: null,
        isPinned: false,
        isMuted: false,
      },
    });
    const pinnedOlder = makeConv({
      public_id: 'c-pinned-old',
      lastMessageAt: '2026-11-24T10:00:00.000Z',
      myState: {
        inboxState: 'primary',
        pendingMessagesSent: 0,
        pendingMessagesRemaining: 3,
        lastReadSeq: 0,
        pinnedAt: '2026-11-24T11:00:00.000Z',
        mutedAt: '2026-11-24T11:30:00.000Z',
        isPinned: true,
        isMuted: true,
      },
    });
    const pinnedNewer = makeConv({
      public_id: 'c-pinned-new',
      lastMessageAt: '2026-11-24T09:00:00.000Z',
      myState: {
        inboxState: 'primary',
        pendingMessagesSent: 0,
        pendingMessagesRemaining: 3,
        lastReadSeq: 0,
        pinnedAt: '2026-11-24T12:00:00.000Z',
        mutedAt: null,
        isPinned: true,
        isMuted: false,
      },
    });

    const sorted = sortPrimaryConversationsWithPins([unpinnedNewest, pinnedOlder, pinnedNewer]);
    expect(sorted.map((c) => c.public_id)).toEqual([
      'c-pinned-new',
      'c-pinned-old',
      'c-unpinned-new',
    ]);

    // Đoạn chat đã tắt thông báo vẫn chưa đọc trên dòng, nhưng KHÔNG cộng vào huy hiệu đỏ toàn cục.
    expect(isConversationUnread(pinnedOlder)).toBe(true);
    expect(isConversationUnreadForBadge(pinnedOlder)).toBe(false);
    expect(isConversationUnreadForBadge(pinnedNewer)).toBe(true);
  });

  it('kiểm tra đúng điều kiện hành động tin nhắn, preview tin ghim khi needs_restore & định dạng giờ menu', () => {
    const primaryConv = makeConv();
    const pendingConv = makeConv({
      isAwaitingPeerAcceptance: true,
      canSendMedia: false,
    });
    const textItem = makeMessageItem();
    const recalledItem = makeMessageItem({
      dto: { ...makeMessageItem().dto, recalledAt: '2026-11-24T12:01:00.000Z' },
    });
    const callItem = makeMessageItem({
      dto: { ...makeMessageItem().dto, messageType: 'call_event' },
    });
    const lockedItem = makeMessageItem({ decryptionFailed: true });

    expect(canReactToMessage(textItem, primaryConv)).toBe(true);
    expect(canReactToMessage(textItem, pendingConv)).toBe(false);
    expect(canReactToMessage(recalledItem, primaryConv)).toBe(false);
    expect(canReactToMessage(callItem, primaryConv)).toBe(false);

    expect(canPinMessage(textItem, primaryConv)).toBe(true);
    expect(canPinMessage(textItem, pendingConv)).toBe(false);
    expect(canPinMessage(callItem, primaryConv)).toBe(false);

    expect(canReplyToMessage(textItem)).toBe(true);
    expect(canReplyToMessage(lockedItem)).toBe(false);
    expect(canForwardMessage(textItem)).toBe(true);
    expect(canForwardMessage(lockedItem)).toBe(false);
    expect(canCopyMessage(textItem)).toBe(true);
    expect(canCopyMessage(recalledItem)).toBe(false);

    const replyPayload = buildReplyPayloadFromMessage(textItem);
    expect(replyPayload.messagePublicId).toBe(textItem.dto.public_id);
    expect(replyPayload.textExcerpt).toBe('Xin chào Tomato');

    expect(getPinnedMessagePreviewText(lockedItem, { needsPinSync: true })).toBe(
      PINNED_MESSAGE_NEEDS_PIN_LABEL,
    );
    expect(formatMessageMenuTimestampVi('2026-11-24T14:05:00.000Z')).toMatch(
      /^\d{2}:\d{2} (CN|T[2-7])$/,
    );
  });

  it('đảm bảo cửa sổ nhắn tin nhỏ đã được đơn giản hóa (không chứa nút gọi thoại/video và không xóa đoạn chat)', () => {
    const miniWidgetSource = readFileSync(
      join(process.cwd(), 'src/components/messages/floating-messages-widget.tsx'),
      'utf8',
    );
    expect(miniWidgetSource).not.toContain('CallActionButtons');
    expect(miniWidgetSource).not.toContain('deleteConversationForMe');
    expect(miniWidgetSource).toContain('showDelete={false}');
  });
});
