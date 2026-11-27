export interface ConversationScrollTracker<TElement = unknown> {
  lastScrolledConvId: string | null;
  lastScrolledContainer: TElement | null;
  lastBottomItemKey: string | null;
  isNearBottom: boolean;
}

export function createConversationScrollTracker<
  TElement = unknown,
>(): ConversationScrollTracker<TElement> {
  return {
    lastScrolledConvId: null,
    lastScrolledContainer: null,
    lastBottomItemKey: null,
    isNearBottom: true,
  };
}

export function resetConversationScrollTracker<TElement = unknown>(
  tracker: ConversationScrollTracker<TElement>,
): void {
  tracker.lastScrolledConvId = null;
  tracker.lastScrolledContainer = null;
  tracker.lastBottomItemKey = null;
  tracker.isNearBottom = true;
}

export type ScrollSyncDecision = 'none' | 'scroll_to_bottom';

/**
 * Quyết định tự động cuộn xuống tin nhắn mới nhất ở đáy khung chat:
 * - Khi mở mới một đoạn chat, chuyển sang đoạn chat khác, HOẶC bấm Quay lại (`<-`) / đóng cửa sổ rồi mở lại
 *   chính đoạn chat đó (tracker đã reset hoặc thẻ DOM `container` được mount mới) -> luôn trả về `'scroll_to_bottom'`.
 * - Khi có tin nhắn mới thêm vào cuối danh sách -> cuộn xuống đáy nếu là tin của chính mình hoặc người dùng đang ở gần đáy.
 */
export function evaluateConversationAutoScroll<TElement>(
  tracker: ConversationScrollTracker<TElement>,
  params: {
    readonly convId: string | null;
    readonly container: TElement | null;
    readonly isViewportOpen: boolean;
    readonly hasInitialized: boolean;
    readonly latestMessageClientId: string | null;
    readonly isLatestOwnMessage: boolean;
  },
): ScrollSyncDecision {
  if (!params.isViewportOpen || !params.convId || !params.container) {
    resetConversationScrollTracker(tracker);
    return 'none';
  }

  const latestKey = params.latestMessageClientId
    ? `${params.convId}:${params.latestMessageClientId}`
    : `${params.convId}:empty`;

  const isFreshOpenOrRemount =
    tracker.lastScrolledConvId !== params.convId ||
    tracker.lastScrolledContainer !== params.container;

  if (isFreshOpenOrRemount) {
    if (!params.hasInitialized) {
      return 'none';
    }
    tracker.lastScrolledConvId = params.convId;
    tracker.lastScrolledContainer = params.container;
    tracker.lastBottomItemKey = latestKey;
    tracker.isNearBottom = true;
    return 'scroll_to_bottom';
  }

  if (tracker.lastBottomItemKey !== latestKey) {
    tracker.lastBottomItemKey = latestKey;
    if (params.isLatestOwnMessage || tracker.isNearBottom) {
      tracker.isNearBottom = true;
      return 'scroll_to_bottom';
    }
  }

  return 'none';
}

export function hasCompletedInitialConversationScroll<TElement>(
  tracker: ConversationScrollTracker<TElement>,
  convId: string | null,
  container: TElement | null,
): boolean {
  return (
    convId !== null &&
    container !== null &&
    tracker.lastScrolledConvId === convId &&
    tracker.lastScrolledContainer === container
  );
}
