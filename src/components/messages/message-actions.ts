import type {
  GroupableMessageItem,
  MessageBubbleClusterPosition,
} from '@/components/messages/message-grouping';
import type { ChatMessageDto } from '@/modules/chat';

export const MESSAGE_EDIT_WINDOW_MS = 5 * 60 * 1000;
export const MESSAGE_RECALL_WINDOW_MS = 5 * 60 * 1000;
export const MAX_MESSAGE_EDIT_COUNT = 5;
export const RECALLED_MESSAGE_PLACEHOLDER = 'Tin nhắn đã được thu hồi';

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
    item.dto.recalledAt !== null
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
): string {
  if (!lastMessage) {
    return 'Bắt đầu cuộc trò chuyện';
  }
  if (lastMessage.recalledAt !== null) {
    return RECALLED_MESSAGE_PLACEHOLDER;
  }
  if (decryptionFailed) {
    return 'Tin nhắn riêng tư';
  }
  const text = decryptedPlaintext ?? '';
  return `${lastMessage.isOwnMessage ? 'Bạn: ' : ''}${text}`;
}
