import type { DecryptedMessageMediaPayload } from '@/lib/e2ee/types';
import type { ChatMessageDto, ConversationSummaryDto } from '@/modules/chat';

/** Các tin nhắn liên tiếp của cùng 1 người gửi cách nhau dưới 3 phút được gom vào cùng 1 cụm. */
export const MESSAGE_CLUSTER_WINDOW_MS = 3 * 60 * 1000;

/** Chèn dòng thời gian ngăn cách ở giữa (Time Divider) khi 2 tin nhắn cách nhau từ 15 phút trở lên. */
export const MESSAGE_TIME_DIVIDER_GAP_MS = 15 * 60 * 1000;

export type MessageBubbleClusterPosition = 'single' | 'first' | 'middle' | 'last';

export interface GroupableMessageItem {
  readonly dto: ChatMessageDto;
  readonly plaintext: string;
  readonly media?: DecryptedMessageMediaPayload;
  readonly localPreviewUrl?: string;
  readonly decryptionFailed: boolean;
  readonly sending?: boolean;
  readonly sendError?: string | null;
}

export interface ClusteredMessageEntry<TItem extends GroupableMessageItem = GroupableMessageItem> {
  readonly item: TItem;
  readonly clusterPosition: MessageBubbleClusterPosition;
  readonly showPeerAvatar: boolean;
  readonly timeDividerLabel: string | null;
  readonly isLastReadByPeer: boolean;
  readonly isLatestOwnSentUnread: boolean;
}

function isSameLocalCalendarDay(dateA: Date, dateB: Date): boolean {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function formatHHmm(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Kiểm tra có cần chèn mốc thời gian ngăn cách (Time Divider) trước tin nhắn hiện tại hay không:
 * - Luôn chèn ở tin nhắn đầu tiên của danh sách đang hiển thị.
 * - Chèn khi qua ngày dương lịch mới.
 * - Chèn khi 2 tin nhắn cách nhau từ 15 phút trở lên.
 */
export function shouldInsertTimeDivider(
  previousCreatedAtIso: string | null,
  currentCreatedAtIso: string,
): boolean {
  if (!previousCreatedAtIso) {
    return true;
  }
  const prevMs = Date.parse(previousCreatedAtIso);
  const currMs = Date.parse(currentCreatedAtIso);
  if (Number.isNaN(prevMs) || Number.isNaN(currMs)) {
    return false;
  }
  const prevDate = new Date(prevMs);
  const currDate = new Date(currMs);
  if (!isSameLocalCalendarDay(prevDate, currDate)) {
    return true;
  }
  return currMs - prevMs >= MESSAGE_TIME_DIVIDER_GAP_MS;
}

/**
 * Định dạng nhãn mốc thời gian ngăn cách ở giữa khung chat (chuẩn Messenger / Instagram):
 * - Cùng ngày hôm nay: "23:45"
 * - Hôm qua: "Hôm qua 14:20"
 * - Cùng năm: "20 thg 11, 09:15"
 * - Khác năm: "20 thg 11, 2025, 09:15"
 */
export function formatMessageTimeDividerVi(isoTimestamp: string, now: Date = new Date()): string {
  const parsedMs = Date.parse(isoTimestamp);
  if (Number.isNaN(parsedMs)) {
    return '';
  }
  const date = new Date(parsedMs);
  const timePart = formatHHmm(date);

  if (isSameLocalCalendarDay(date, now)) {
    return timePart;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameLocalCalendarDay(date, yesterday)) {
    return `Hôm qua ${timePart}`;
  }

  const day = date.getDate();
  const month = date.getMonth() + 1;

  if (date.getFullYear() === now.getFullYear()) {
    return `${day} thg ${month}, ${timePart}`;
  }

  return `${day} thg ${month}, ${date.getFullYear()}, ${timePart}`;
}

/**
 * Định dạng thời gian chi tiết hiển thị trong Radix Tooltip khi hover/focus lên bong bóng tin nhắn:
 * Ví dụ: "23:54 • 24 thg 11, 2026"
 */
export function formatExactMessageTooltipTimeVi(isoTimestamp: string): string {
  const parsedMs = Date.parse(isoTimestamp);
  if (Number.isNaN(parsedMs)) {
    return '';
  }
  const date = new Date(parsedMs);
  const timePart = formatHHmm(date);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${timePart} • ${day} thg ${month}, ${year}`;
}

/**
 * Định dạng thời gian ngắn gọn cho danh sách hội thoại bên trái `/messages`.
 */
export function formatConversationShortTimeVi(
  isoTimestamp: string | null,
  nowMs: number = Date.now(),
): string {
  if (!isoTimestamp) {
    return '';
  }
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 60) {
    return 'Vừa xong';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} phút`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours} giờ`;
  }
  const date = new Date(parsed);
  return `${date.getDate()} thg ${date.getMonth() + 1}`;
}

/**
 * Kiểm tra một cuộc hội thoại có đang chứa tin nhắn chưa đọc từ đối phương hay không.
 * Luôn xét mốc `GREATEST(lastReadSeq, clearedBeforeSeq)` để xóa đoạn chat có tin chưa đọc
 * vẫn xóa sạch trạng thái chưa đọc mà không cần tăng giả `lastReadSeq`.
 */
export function isConversationUnread(conv: ConversationSummaryDto): boolean {
  const effectiveReadFloor = Math.max(conv.myState.lastReadSeq, conv.myState.clearedBeforeSeq ?? 0);
  if (conv.lastSeq <= effectiveReadFloor) {
    return false;
  }
  if (!conv.lastMessage) {
    return false;
  }
  if (conv.lastMessage.isOwnMessage) {
    return false;
  }
  if (conv.lastMessage.seq <= effectiveReadFloor) {
    return false;
  }
  return true;
}

function canClusterTogether(
  prev: GroupableMessageItem,
  curr: GroupableMessageItem,
  hasDividerBetween: boolean,
): boolean {
  if (hasDividerBetween) {
    return false;
  }
  if (prev.dto.messageType === 'call_event' || curr.dto.messageType === 'call_event') {
    return false;
  }
  if (prev.dto.senderPublicId !== curr.dto.senderPublicId) {
    return false;
  }
  const prevMs = Date.parse(prev.dto.createdAt);
  const currMs = Date.parse(curr.dto.createdAt);
  if (Number.isNaN(prevMs) || Number.isNaN(currMs)) {
    return false;
  }
  return Math.abs(currMs - prevMs) < MESSAGE_CLUSTER_WINDOW_MS;
}

/**
 * Tính toán danh sách hiển thị tin nhắn chuẩn Messenger / Instagram:
 * - Chèn `timeDividerLabel` ở đầu cuộc trò chuyện, khi qua ngày mới hoặc cách nhau >= 15 phút.
 * - Gom nhóm các tin nhắn liên tiếp cùng người gửi cách nhau < 3 phút (`single` | `first` | `middle` | `last`).
 * - Chỉ hiển thị avatar nhỏ của đối phương ở tin cuối cùng của mỗi cụm (`single` hoặc `last`).
 * - Xác định duy nhất 1 tin nhắn mới nhất của mình đã được đối phương xem (`seq <= peerLastReadSeq`) để gắn nhãn "Đã xem".
 */
export function buildClusteredMessageEntries<TItem extends GroupableMessageItem>(
  items: readonly TItem[],
  peerLastReadSeq: number | null,
  now: Date = new Date(),
): ClusteredMessageEntry<TItem>[] {
  if (items.length === 0) {
    return [];
  }

  const dividers: (string | null)[] = items.map((item, idx) => {
    const prevIso = idx > 0 ? (items[idx - 1]?.dto.createdAt ?? null) : null;
    if (shouldInsertTimeDivider(prevIso, item.dto.createdAt)) {
      return formatMessageTimeDividerVi(item.dto.createdAt, now);
    }
    return null;
  });

  // Chỉ gắn nhãn "Đã xem" hoặc "Đã gửi" cho tin nhắn mới nhất của cả cuộc trò chuyện
  // khi tin nhắn đó do chính mình gửi (đã gửi thành công, chưa bị thu hồi, và chưa có tin trả lời nào của đối phương phía sau).
  let lastReadOwnClientMsgId: string | null = null;
  let latestOwnSentUnreadClientMsgId: string | null = null;

  const latestConversationItem = items[items.length - 1];
  if (
    latestConversationItem &&
    latestConversationItem.dto.isOwnMessage &&
    latestConversationItem.dto.messageType !== 'call_event' &&
    !latestConversationItem.sending &&
    !latestConversationItem.sendError &&
    latestConversationItem.dto.recalledAt === null &&
    latestConversationItem.dto.seq > 0
  ) {
    if (
      typeof peerLastReadSeq === 'number' &&
      peerLastReadSeq > 0 &&
      latestConversationItem.dto.seq <= peerLastReadSeq
    ) {
      lastReadOwnClientMsgId = latestConversationItem.dto.clientMsgId;
    } else {
      latestOwnSentUnreadClientMsgId = latestConversationItem.dto.clientMsgId;
    }
  }

  return items.map((item, idx) => {
    const prev = idx > 0 ? items[idx - 1] : undefined;
    const next = idx < items.length - 1 ? items[idx + 1] : undefined;

    const groupedWithPrev =
      prev !== undefined && canClusterTogether(prev, item, dividers[idx] !== null);
    const groupedWithNext =
      next !== undefined && canClusterTogether(item, next, dividers[idx + 1] !== null);

    let clusterPosition: MessageBubbleClusterPosition;
    if (!groupedWithPrev && !groupedWithNext) {
      clusterPosition = 'single';
    } else if (!groupedWithPrev && groupedWithNext) {
      clusterPosition = 'first';
    } else if (groupedWithPrev && groupedWithNext) {
      clusterPosition = 'middle';
    } else {
      clusterPosition = 'last';
    }

    const isEndOfCluster = clusterPosition === 'single' || clusterPosition === 'last';
    const showPeerAvatar =
      !item.dto.isOwnMessage && item.dto.messageType !== 'call_event' && isEndOfCluster;

    return {
      item,
      clusterPosition,
      showPeerAvatar,
      timeDividerLabel: dividers[idx] ?? null,
      isLastReadByPeer:
        lastReadOwnClientMsgId !== null && item.dto.clientMsgId === lastReadOwnClientMsgId,
      isLatestOwnSentUnread:
        latestOwnSentUnreadClientMsgId !== null &&
        item.dto.clientMsgId === latestOwnSentUnreadClientMsgId,
    };
  });
}
