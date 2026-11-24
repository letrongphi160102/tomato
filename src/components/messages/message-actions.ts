import type {
  GroupableMessageItem,
  MessageBubbleClusterPosition,
} from '@/components/messages/message-grouping';
import type { MessageCallEventMetaRecord } from '@/core/db/schema/messages';
import { sanitizeReplyTextExcerpt } from '@/lib/e2ee/cipher';
import type { DecryptedMessageReplyPayload } from '@/lib/e2ee/types';
import type { ChatMessageDto, ConversationSummaryDto } from '@/modules/chat';

export const MESSAGE_EDIT_WINDOW_MS = 5 * 60 * 1000;
export const MESSAGE_RECALL_WINDOW_MS = 5 * 60 * 1000;
export const MAX_MESSAGE_EDIT_COUNT = 5;
export const MAX_PINNED_MESSAGES = 5;
export const MAX_PINNED_CONVERSATIONS = 3;
export const MAX_FORWARD_RECIPIENTS = 5;
export const MAX_JUMP_LOAD_PAGES = 4;
export const RECALLED_MESSAGE_PLACEHOLDER = 'Tin nhắn đã được thu hồi';
export const IMAGE_MESSAGE_PREVIEW_LABEL = 'Đã gửi một ảnh';
export const VOICE_MESSAGE_PREVIEW_LABEL = 'Tin nhắn thoại';
export const PIN_SYNC_REQUIRED_PREVIEW = 'Nhập mã PIN để xem tin nhắn';
export const PINNED_MESSAGE_NEEDS_PIN_LABEL = 'Nhập mã PIN để xem tin nhắn đã ghim';
export const UNAVAILABLE_OLD_MESSAGE_PREVIEW = 'Tin nhắn không khả dụng trên thiết bị này';

export function formatCallEventDurationVi(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatCallEventLabel(meta: MessageCallEventMetaRecord | null | undefined): string {
  if (!meta) {
    return 'Cuộc gọi';
  }
  const typeLabel = meta.callType === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
  if (meta.status === 'ended') {
    if (typeof meta.durationSeconds === 'number' && meta.durationSeconds > 0) {
      return `${typeLabel} · ${formatCallEventDurationVi(meta.durationSeconds)}`;
    }
    return `${typeLabel} đã kết thúc`;
  }
  if (meta.status === 'missed') {
    return 'Cuộc gọi nhỡ';
  }
  if (meta.status === 'declined') {
    return 'Cuộc gọi bị từ chối';
  }
  return 'Người nhận đang bận';
}

/**
 * Kiểm tra tin nhắn có còn đủ điều kiện hiển thị nút "Chỉnh sửa" trên UI hay không.
 * Lưu ý: Server luôn là nguồn cưỡng chế duy nhất theo đồng hồ PostgreSQL/Server.
 */
export function canEditMessage(item: GroupableMessageItem, nowMs: number = Date.now()): boolean {
  if (
    !item.dto.isOwnMessage ||
    item.sending ||
    Boolean(item.sendError) ||
    item.decryptionFailed ||
    item.dto.seq <= 0 ||
    item.dto.messageType !== 'text' ||
    item.dto.recalledAt !== null ||
    item.dto.editCount >= MAX_MESSAGE_EDIT_COUNT
  ) {
    return false;
  }

  const createdAtMs = Date.parse(item.dto.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs <= MESSAGE_EDIT_WINDOW_MS;
}

/**
 * Kiểm tra tin nhắn có còn đủ điều kiện hiển thị nút "Thu hồi" trên UI hay không.
 */
export function canRecallMessage(item: GroupableMessageItem, nowMs: number = Date.now()): boolean {
  if (
    !item.dto.isOwnMessage ||
    item.sending ||
    Boolean(item.sendError) ||
    item.dto.seq <= 0 ||
    item.dto.recalledAt !== null ||
    item.dto.messageType === 'call_event'
  ) {
    return false;
  }

  const createdAtMs = Date.parse(item.dto.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  return nowMs - createdAtMs <= MESSAGE_RECALL_WINDOW_MS;
}

/**
 * Mọi tin nhắn đã gửi thành công (của mình, đối phương, kể cả tin đã thu hồi) đều có thể "Xóa ở phía bạn".
 */
export function canDeleteMessageForMe(item: GroupableMessageItem): boolean {
  return !item.sending && !item.sendError && item.dto.seq > 0;
}

export function isConversationPrimaryBothSides(
  conversation?: ConversationSummaryDto | null,
): boolean {
  if (!conversation) {
    return true;
  }
  return conversation.myState.inboxState === 'primary' && !conversation.isAwaitingPeerAcceptance;
}

export function canReactToMessage(
  item: GroupableMessageItem,
  conversation?: ConversationSummaryDto | null,
): boolean {
  if (
    item.sending ||
    Boolean(item.sendError) ||
    item.dto.seq <= 0 ||
    item.dto.recalledAt !== null ||
    item.dto.messageType === 'call_event'
  ) {
    return false;
  }
  return isConversationPrimaryBothSides(conversation);
}

export function canReplyToMessage(item: GroupableMessageItem): boolean {
  return (
    !item.sending &&
    !item.sendError &&
    item.dto.seq > 0 &&
    item.dto.recalledAt === null &&
    item.dto.messageType !== 'call_event' &&
    !item.decryptionFailed
  );
}

export function canForwardMessage(item: GroupableMessageItem): boolean {
  return (
    !item.sending &&
    !item.sendError &&
    item.dto.seq > 0 &&
    item.dto.recalledAt === null &&
    item.dto.messageType !== 'call_event' &&
    !item.decryptionFailed
  );
}

export function canCopyMessage(item: GroupableMessageItem): boolean {
  return (
    !item.sending &&
    !item.sendError &&
    item.dto.recalledAt === null &&
    item.dto.messageType === 'text' &&
    !item.decryptionFailed &&
    item.plaintext.trim().length > 0
  );
}

export function canPinMessage(
  item: GroupableMessageItem,
  conversation?: ConversationSummaryDto | null,
): boolean {
  if (
    item.sending ||
    Boolean(item.sendError) ||
    item.dto.seq <= 0 ||
    item.dto.recalledAt !== null ||
    item.dto.messageType === 'call_event'
  ) {
    return false;
  }
  return isConversationPrimaryBothSides(conversation);
}

export function buildReplyPayloadFromMessage(
  item: GroupableMessageItem,
): DecryptedMessageReplyPayload {
  const messageType =
    item.dto.messageType === 'image'
      ? 'image'
      : item.dto.messageType === 'voice'
        ? 'voice'
        : 'text';
  const rawExcerpt =
    messageType === 'image'
      ? 'Hình ảnh'
      : messageType === 'voice'
        ? VOICE_MESSAGE_PREVIEW_LABEL
        : item.plaintext;
  return {
    messagePublicId: item.dto.public_id,
    senderPublicId: item.dto.senderPublicId,
    messageType,
    textExcerpt: sanitizeReplyTextExcerpt(rawExcerpt),
  };
}

export function getPinnedMessagePreviewText(
  item: GroupableMessageItem,
  options?: { readonly needsPinSync?: boolean },
): string {
  if (item.dto.recalledAt !== null) {
    return RECALLED_MESSAGE_PLACEHOLDER;
  }
  if (item.decryptionFailed) {
    return options?.needsPinSync ? PINNED_MESSAGE_NEEDS_PIN_LABEL : UNAVAILABLE_OLD_MESSAGE_PREVIEW;
  }
  if (item.dto.messageType === 'image') {
    return 'Hình ảnh';
  }
  if (item.dto.messageType === 'voice') {
    return VOICE_MESSAGE_PREVIEW_LABEL;
  }
  return item.plaintext.trim() || 'Tin nhắn';
}

export function getMessageBubbleRadiusClasses(
  isMine: boolean,
  position: MessageBubbleClusterPosition,
): string {
  if (isMine) {
    switch (position) {
      case 'single':
        return 'rounded-2xl';
      case 'first':
        return 'rounded-2xl rounded-br-md';
      case 'middle':
        return 'rounded-2xl rounded-tr-md rounded-br-md';
      case 'last':
        return 'rounded-2xl rounded-tr-md';
    }
  }

  switch (position) {
    case 'single':
      return 'rounded-2xl';
    case 'first':
      return 'rounded-2xl rounded-bl-md';
    case 'middle':
      return 'rounded-2xl rounded-tl-md rounded-bl-md';
    case 'last':
      return 'rounded-2xl rounded-tl-md';
  }
}

export function getConversationPreviewText(
  lastMessage: ChatMessageDto | null,
  decryptedPlaintext?: string,
  decryptionFailed?: boolean,
  options?: { readonly needsPinSync?: boolean },
): string {
  if (!lastMessage) {
    return 'Bắt đầu cuộc trò chuyện';
  }
  if (lastMessage.recalledAt !== null) {
    return RECALLED_MESSAGE_PLACEHOLDER;
  }
  if (lastMessage.messageType === 'call_event') {
    return formatCallEventLabel(lastMessage.callEventMeta);
  }
  if (decryptionFailed) {
    return options?.needsPinSync ? PIN_SYNC_REQUIRED_PREVIEW : UNAVAILABLE_OLD_MESSAGE_PREVIEW;
  }
  if (lastMessage.messageType === 'image') {
    return `${lastMessage.isOwnMessage ? 'Bạn: ' : ''}${IMAGE_MESSAGE_PREVIEW_LABEL}`;
  }
  if (lastMessage.messageType === 'voice') {
    return `${lastMessage.isOwnMessage ? 'Bạn: ' : ''}${VOICE_MESSAGE_PREVIEW_LABEL}`;
  }
  const text = decryptedPlaintext ?? '';
  return `${lastMessage.isOwnMessage ? 'Bạn: ' : ''}${text}`;
}
