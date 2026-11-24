'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Loader2,
  Lock,
  Maximize2,
  MessageCircle,
  PenSquare,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';

import {
  shouldRenderFloatingMessagesWidget,
  useChatStore,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import { EmojiPickerPopover } from '@/components/messages/emoji-picker-popover';
import {
  buildClusteredMessageEntries,
  formatConversationShortTimeVi,
  formatExactMessageTooltipTimeVi,
  isConversationUnread,
  type MessageBubbleClusterPosition,
} from '@/components/messages/message-grouping';
import { NewMessageModal } from '@/components/messages/new-message-modal';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ConversationSummaryDto } from '@/modules/chat';

const EMPTY_CONVERSATIONS: readonly ConversationSummaryDto[] = [];
const EMPTY_MESSAGES: readonly DecryptedMessageViewItem[] = [];

function getMiniBubbleRadiusClasses(
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

export function FloatingMessagesWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const realtime = useRealtimePresence();
  const chatStore = useChatStore();

  const isAllowedOnCurrentRoute = shouldRenderFloatingMessagesWidget(pathname);

  const [isOpen, setIsOpen] = React.useState(false);
  const [activeMiniConvId, setActiveMiniConvId] = React.useState<string | null>(null);
  const [draftText, setDraftText] = React.useState('');
  const [chatError, setChatError] = React.useState<string | null>(null);
  const [newMessageModalOpen, setNewMessageModalOpen] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState(false);

  const messagesContainerRef = React.useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = React.useRef(true);
  const lastScrolledConvIdRef = React.useRef<string | null>(null);
  const lastBottomItemKeyRef = React.useRef<string | null>(null);
  const scrollAnchorRef = React.useRef<{
    readonly convId: string;
    readonly prevScrollHeight: number;
    readonly prevScrollTop: number;
    readonly prevCount: number;
  } | null>(null);

  const activeTab = chatStore?.activeTab ?? 'primary';
  const primaryConversations = chatStore?.primaryConversations ?? EMPTY_CONVERSATIONS;
  const pendingConversations = chatStore?.pendingConversations ?? EMPTY_CONVERSATIONS;
  const conversations = activeTab === 'primary' ? primaryConversations : pendingConversations;
  const hasLoadedCurrentTab =
    activeTab === 'primary'
      ? (chatStore?.hasLoadedPrimary ?? false)
      : (chatStore?.hasLoadedPending ?? false);
  const loadingConversations = (chatStore?.loadingConversations ?? false) && !hasLoadedCurrentTab;
  const unreadMessagesCount = Math.max(0, chatStore?.unreadConversationsCount ?? 0);
  const unreadMessagesBadgeText = unreadMessagesCount > 99 ? '99+' : String(unreadMessagesCount);
  const pendingCount = chatStore?.pendingCount ?? 0;
  const previewsByConvId = chatStore?.previewsByConvId ?? {};
  const presences = chatStore?.presences ?? {};
  const selectedConversation = chatStore?.selectedConversation ?? null;

  const activeMiniConversation = React.useMemo<ConversationSummaryDto | null>(() => {
    if (!activeMiniConvId) {
      return null;
    }
    return (
      primaryConversations.find((c) => c.public_id === activeMiniConvId) ??
      pendingConversations.find((c) => c.public_id === activeMiniConvId) ??
      (selectedConversation?.public_id === activeMiniConvId ? selectedConversation : null)
    );
  }, [activeMiniConvId, pendingConversations, primaryConversations, selectedConversation]);

  const activeThread =
    activeMiniConversation && chatStore
      ? chatStore.getThreadState(activeMiniConversation.public_id)
      : null;
  const messages = activeThread?.items ?? EMPTY_MESSAGES;
  const loadingInitialMessages =
    Boolean(activeMiniConversation) &&
    (!activeThread || (activeThread.loadingInitial && !activeThread.hasInitialized));
  const loadingOlderMessages = activeThread?.loadingOlder ?? false;
  const hasOlderMessages = (activeThread?.nextBeforeSeq ?? null) !== null;

  const peerKeyBundle =
    activeMiniConversation && chatStore
      ? chatStore.getCachedPeerKeyBundle(activeMiniConversation.peer.public_id)
      : null;

  const setFloatingViewportConversation = chatStore?.setFloatingViewportConversation;
  const loadConversations = chatStore?.loadConversations;
  const refreshOwnE2eeStatus = chatStore?.refreshOwnE2eeStatus;

  // Đồng bộ ngữ cảnh auto-read của cửa sổ nổi với `ChatStoreProvider`.
  React.useEffect(() => {
    if (!setFloatingViewportConversation) {
      return;
    }
    if (isAllowedOnCurrentRoute && isOpen && activeMiniConversation) {
      setFloatingViewportConversation(activeMiniConversation.public_id);
    } else {
      setFloatingViewportConversation(null);
    }
    return () => {
      setFloatingViewportConversation(null);
    };
  }, [activeMiniConversation, isAllowedOnCurrentRoute, isOpen, setFloatingViewportConversation]);

  // Khi mở cửa sổ nổi, làm mới danh sách hội thoại theo tab hiện tại và đảm bảo khóa E2EE cá nhân đã sẵn sàng.
  React.useEffect(() => {
    if (!isOpen || !isAllowedOnCurrentRoute) {
      return;
    }
    if (refreshOwnE2eeStatus) {
      void refreshOwnE2eeStatus();
    }
    if (loadConversations) {
      void loadConversations(activeTab, { background: hasLoadedCurrentTab });
    }
  }, [
    activeTab,
    hasLoadedCurrentTab,
    isAllowedOnCurrentRoute,
    isOpen,
    loadConversations,
    refreshOwnE2eeStatus,
  ]);

  // Scroll Anchoring khi tải tin nhắn cũ (`beforeSeq`) + Cuộn thông minh xuống đáy khi mở đoạn chat hoặc gửi/nhận tin mới.
  React.useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !activeMiniConversation || !isOpen) {
      return;
    }

    const convId = activeMiniConversation.public_id;
    const anchor = scrollAnchorRef.current;

    if (anchor && anchor.convId === convId && messages.length > anchor.prevCount) {
      const heightDiff = container.scrollHeight - anchor.prevScrollHeight;
      container.scrollTop = anchor.prevScrollTop + heightDiff;
      scrollAnchorRef.current = null;
      return;
    }

    const latestItem = messages[messages.length - 1];
    const latestKey = latestItem ? `${convId}:${latestItem.dto.clientMsgId}` : `${convId}:empty`;

    if (lastScrolledConvIdRef.current !== convId) {
      if (activeThread?.hasInitialized) {
        container.scrollTop = container.scrollHeight;
        isNearBottomRef.current = true;
        lastScrolledConvIdRef.current = convId;
        lastBottomItemKeyRef.current = latestKey;
      }
      return;
    }

    if (lastBottomItemKeyRef.current !== latestKey) {
      lastBottomItemKeyRef.current = latestKey;
      if (latestItem?.dto.isOwnMessage || isNearBottomRef.current) {
        container.scrollTop = container.scrollHeight;
        isNearBottomRef.current = true;
      }
    }
  }, [activeMiniConversation, activeThread?.hasInitialized, isOpen, messages]);

  const handleMessagesScroll = React.useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || !activeMiniConversation || !chatStore) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= 120;

    if (
      container.scrollTop <= 56 &&
      hasOlderMessages &&
      !loadingOlderMessages &&
      !scrollAnchorRef.current
    ) {
      scrollAnchorRef.current = {
        convId: activeMiniConversation.public_id,
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
        prevCount: messages.length,
      };
      void chatStore.loadOlderMessages(activeMiniConversation.public_id).then((added) => {
        if (!added) {
          scrollAnchorRef.current = null;
        }
      });
    }
  }, [activeMiniConversation, chatStore, hasOlderMessages, loadingOlderMessages, messages.length]);

  const clusteredMessages = React.useMemo(
    () => buildClusteredMessageEntries(messages, activeMiniConversation?.peerLastReadSeq ?? null),
    [activeMiniConversation?.peerLastReadSeq, messages],
  );

  if (!isAllowedOnCurrentRoute) {
    return null;
  }

  function handleExpandToFullMessages() {
    if (activeMiniConversation && chatStore) {
      chatStore.selectConversation(activeMiniConversation);
    }
    setFloatingViewportConversation?.(null);
    setActiveMiniConvId(null);
    setIsOpen(false);
    router.push('/messages');
  }

  function handleCloseWidget() {
    setFloatingViewportConversation?.(null);
    setActiveMiniConvId(null);
    setIsOpen(false);
    setChatError(null);
  }

  function handleSelectMiniConversation(conv: ConversationSummaryDto) {
    setChatError(null);
    setActiveMiniConvId(conv.public_id);
    void chatStore?.openConversationThread(conv);
  }

  async function handleSendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    const textToSend = draftText.trim();
    if (!textToSend) {
      return;
    }
    setDraftText('');
    setChatError(null);
    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: activeMiniConversation,
        plaintext: textToSend,
      });
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Không thể gửi tin nhắn. Vui lòng thử lại.',
      );
    }
  }

  async function handleRetryFailedMessage(clientMsgId: string, plaintext: string) {
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: activeMiniConversation,
        plaintext,
        retryClientMsgId: clientMsgId,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể gửi lại tin nhắn lúc này.');
    }
  }

  async function handleAcceptPending() {
    if (!activeMiniConversation || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      await chatStore.acceptSelectedPendingConversation(activeMiniConversation.public_id);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể chấp nhận cuộc trò chuyện.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeclinePending() {
    if (!activeMiniConversation || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      await chatStore.declineSelectedPendingConversation(activeMiniConversation.public_id);
      setActiveMiniConvId(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể xóa yêu cầu tin nhắn.');
    } finally {
      setActionBusy(false);
    }
  }

  const canShowSelectedPeerPresence = Boolean(
    activeMiniConversation &&
    activeMiniConversation.myState.inboxState === 'primary' &&
    !activeMiniConversation.isAwaitingPeerAcceptance &&
    (realtime?.activeStatusEnabled ?? true),
  );
  const selectedPeerPresence =
    canShowSelectedPeerPresence && activeMiniConversation
      ? (presences[activeMiniConversation.peer.public_id.toLowerCase()] ?? null)
      : null;

  const isViewingPendingRequest = activeMiniConversation?.myState.inboxState === 'pending';
  const recipientHasZeroKeys = peerKeyBundle !== null && peerKeyBundle.devices.length === 0;

  return (
    <TooltipProvider delayDuration={180}>
      <div className="fixed right-4 bottom-16 z-30 md:bottom-5">
        {!isOpen ? (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            aria-label={
              unreadMessagesCount > 0
                ? `Mở cửa sổ tin nhắn (${unreadMessagesCount} cuộc trò chuyện chưa đọc)`
                : 'Mở cửa sổ tin nhắn'
            }
            className="flex items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg transition-all hover:bg-muted/60 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="relative inline-flex items-center justify-center">
              <MessageCircle className="size-5 text-foreground" aria-hidden="true" />
            </span>
            <span>Tin nhắn</span>
            {unreadMessagesCount > 0 ? (
              <span
                aria-hidden="true"
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-destructive-foreground shadow-xs"
              >
                {unreadMessagesBadgeText}
              </span>
            ) : null}
          </button>
        ) : (
          <section
            role="dialog"
            aria-label="Cửa sổ tin nhắn thu gọn"
            className="flex h-[520px] max-h-[calc(100vh-5.5rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl sm:w-[368px]"
          >
            {!activeMiniConversation ? (
              <>
                {/* Header Màn hình Danh sách hội thoại */}
                <header className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-foreground">Tin nhắn</h2>
                    {unreadMessagesCount > 0 ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold leading-none text-destructive-foreground">
                        {unreadMessagesBadgeText}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Mở toàn màn hình tin nhắn"
                      title="Mở toàn màn hình"
                      onClick={handleExpandToFullMessages}
                      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <Maximize2 className="size-4" aria-hidden="true" />
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Đóng cửa sổ tin nhắn"
                      title="Đóng"
                      onClick={handleCloseWidget}
                      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </header>

                {/* 2 Tab: Chính & Tin nhắn đang chờ */}
                <div
                  role="tablist"
                  aria-label="Phân loại hộp thư thu gọn"
                  className="grid grid-cols-2 border-b"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'primary'}
                    onClick={() => chatStore?.setActiveTab('primary')}
                    className={cn(
                      'border-b-2 py-2 text-xs font-semibold transition-colors',
                      activeTab === 'primary'
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Chính
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'pending'}
                    onClick={() => chatStore?.setActiveTab('pending')}
                    className={cn(
                      'inline-flex items-center justify-center gap-1.5 border-b-2 py-2 text-xs font-semibold transition-colors',
                      activeTab === 'pending'
                        ? 'border-foreground text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span>Tin nhắn đang chờ</span>
                    {pendingCount > 0 ? (
                      <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground">
                        {pendingCount > 99 ? '99+' : pendingCount}
                      </span>
                    ) : null}
                  </button>
                </div>

                {/* Danh sách hội thoại */}
                <div className="relative flex-1 overflow-y-auto">
                  {loadingConversations ? (
                    <div className="flex items-center justify-center gap-2 py-14 text-xs text-muted-foreground">
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                      <span>Đang tải hộp thư...</span>
                    </div>
                  ) : conversations.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                      <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <MessageCircle className="size-4" aria-hidden="true" />
                      </div>
                      <p className="mt-2.5 text-xs font-medium text-foreground">
                        {activeTab === 'primary'
                          ? 'Chưa có cuộc trò chuyện nào'
                          : 'Không có tin nhắn đang chờ'}
                      </p>
                      {activeTab === 'primary' ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => setNewMessageModalOpen(true)}
                          className="mt-3 h-7 rounded-lg px-3 text-xs"
                        >
                          Gửi tin nhắn
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <ul className="divide-y pb-14">
                      {conversations.map((conv) => {
                        const isUnread = isConversationUnread(conv);
                        const canShowDot =
                          activeTab === 'primary' &&
                          !conv.isAwaitingPeerAcceptance &&
                          (realtime?.activeStatusEnabled ?? true);
                        const peerPres = canShowDot
                          ? (presences[conv.peer.public_id.toLowerCase()] ?? null)
                          : null;
                        const previewText = previewsByConvId[conv.public_id] ?? 'Tin nhắn mới';

                        return (
                          <li key={conv.public_id}>
                            <button
                              type="button"
                              onClick={() => handleSelectMiniConversation(conv)}
                              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/50"
                            >
                              <div className="relative shrink-0">
                                <UserAvatar
                                  fullName={conv.peer.fullName}
                                  avatarUrl={conv.peer.avatarUrl}
                                  size="sm"
                                />
                                {peerPres?.isOnline ? (
                                  <span
                                    aria-label="Đang hoạt động"
                                    className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
                                  />
                                ) : null}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p
                                    className={cn(
                                      'truncate text-xs text-foreground',
                                      isUnread ? 'font-bold' : 'font-medium',
                                    )}
                                  >
                                    {conv.peer.fullName}
                                  </p>
                                  <span
                                    className={cn(
                                      'shrink-0 text-[10px]',
                                      isUnread
                                        ? 'font-semibold text-foreground'
                                        : 'text-muted-foreground',
                                    )}
                                  >
                                    {formatConversationShortTimeVi(
                                      conv.lastMessageAt ?? conv.createdAt,
                                    )}
                                  </span>
                                </div>
                                <p
                                  className={cn(
                                    'truncate text-[11px]',
                                    isUnread
                                      ? 'font-semibold text-foreground'
                                      : 'font-normal text-muted-foreground',
                                  )}
                                >
                                  {previewText}
                                </p>
                              </div>

                              {isUnread ? (
                                <span
                                  aria-label="Tin nhắn chưa đọc"
                                  className="size-2 shrink-0 rounded-full bg-primary"
                                />
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* Nút nổi soạn Tin nhắn mới góc dưới phải trong cửa sổ */}
                  <Button
                    type="button"
                    size="icon"
                    aria-label="Soạn tin nhắn mới"
                    title="Tin nhắn mới"
                    onClick={() => setNewMessageModalOpen(true)}
                    className="absolute right-3.5 bottom-3.5 size-10 rounded-full shadow-md"
                  >
                    <PenSquare className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* Header Màn hình Trò chuyện thu gọn */}
                <header className="flex items-center justify-between border-b px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Quay lại danh sách tin nhắn"
                      onClick={() => {
                        setChatError(null);
                        setActiveMiniConvId(null);
                      }}
                      className="size-8 shrink-0 rounded-full"
                    >
                      <ArrowLeft className="size-4" aria-hidden="true" />
                    </Button>

                    <Link
                      href={`/u/${encodeURIComponent(activeMiniConversation.peer.handle)}`}
                      className="flex min-w-0 items-center gap-2.5 rounded-lg transition-opacity hover:opacity-90"
                    >
                      <div className="relative shrink-0">
                        <UserAvatar
                          fullName={activeMiniConversation.peer.fullName}
                          avatarUrl={activeMiniConversation.peer.avatarUrl}
                          size="xs"
                          className="size-8"
                        />
                        {selectedPeerPresence?.isOnline ? (
                          <span
                            aria-hidden="true"
                            className="absolute right-0 bottom-0 size-2 rounded-full bg-emerald-500 ring-2 ring-background"
                          />
                        ) : null}
                      </div>

                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {activeMiniConversation.peer.fullName}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {selectedPeerPresence
                            ? selectedPeerPresence.label
                            : `@${activeMiniConversation.peer.handle}`}
                        </p>
                      </div>
                    </Link>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Mở toàn màn hình tin nhắn"
                      title="Mở toàn màn hình"
                      onClick={handleExpandToFullMessages}
                      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <Maximize2 className="size-3.5" aria-hidden="true" />
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Đóng cửa sổ tin nhắn"
                      title="Đóng"
                      onClick={handleCloseWidget}
                      className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </header>

                {/* Lịch sử tin nhắn thu gọn */}
                <div
                  ref={messagesContainerRef}
                  onScroll={handleMessagesScroll}
                  className="flex-1 overflow-y-auto px-3 py-3.5"
                >
                  {loadingOlderMessages ? (
                    <div className="mb-2 flex items-center justify-center py-1">
                      <Loader2
                        aria-label="Đang tải tin nhắn cũ hơn"
                        className="size-3.5 animate-spin text-muted-foreground"
                      />
                    </div>
                  ) : null}

                  {!hasOlderMessages ? (
                    <div className="mx-auto mb-4 max-w-xs text-center">
                      <UserAvatar
                        fullName={activeMiniConversation.peer.fullName}
                        avatarUrl={activeMiniConversation.peer.avatarUrl}
                        size="md"
                        className="mx-auto"
                      />
                      <p className="mt-2 text-xs font-semibold text-foreground">
                        {activeMiniConversation.peer.fullName}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        @{activeMiniConversation.peer.handle}
                      </p>
                      <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-0.5 text-[10px] text-muted-foreground">
                        <Lock className="size-2.5" aria-hidden="true" />
                        <span>Tin nhắn được bảo vệ riêng tư</span>
                      </div>
                    </div>
                  ) : null}

                  {loadingInitialMessages ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2
                        aria-label="Đang đồng bộ tin nhắn"
                        className="size-4 animate-spin text-muted-foreground"
                      />
                    </div>
                  ) : activeThread?.errorMessage && messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                      <p className="text-xs text-muted-foreground">{activeThread.errorMessage}</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void chatStore?.openConversationThread(activeMiniConversation, {
                            forceReload: true,
                          })
                        }
                        className="h-7 gap-1 rounded-lg px-2.5 text-xs"
                      >
                        <RotateCcw className="size-3" aria-hidden="true" />
                        <span>Thử lại</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {clusteredMessages.map((entry, idx) => {
                        const {
                          item,
                          clusterPosition,
                          showPeerAvatar,
                          timeDividerLabel,
                          isLastReadByPeer,
                          isLatestOwnSentUnread,
                        } = entry;
                        const isMine = item.dto.isOwnMessage;
                        const isNewCluster =
                          clusterPosition === 'single' || clusterPosition === 'first';
                        const exactTooltipTime = formatExactMessageTooltipTimeVi(
                          item.dto.createdAt,
                        );

                        return (
                          <React.Fragment key={item.dto.clientMsgId}>
                            {timeDividerLabel ? (
                              <div className="my-2.5 flex justify-center">
                                <span className="rounded-full bg-muted/50 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  {timeDividerLabel}
                                </span>
                              </div>
                            ) : null}

                            <div
                              className={cn(
                                'flex flex-col',
                                isMine ? 'items-end' : 'items-start',
                                idx === 0 || timeDividerLabel
                                  ? 'mt-0.5'
                                  : isNewCluster
                                    ? 'mt-2.5'
                                    : 'mt-0.5',
                              )}
                            >
                              <div
                                className={cn(
                                  'flex max-w-[85%] items-end gap-1.5',
                                  isMine ? 'flex-row-reverse' : 'flex-row',
                                )}
                              >
                                {!isMine ? (
                                  showPeerAvatar ? (
                                    <UserAvatar
                                      fullName={activeMiniConversation.peer.fullName}
                                      avatarUrl={activeMiniConversation.peer.avatarUrl}
                                      size="xs"
                                      className="size-6 shrink-0"
                                    />
                                  ) : (
                                    <span aria-hidden="true" className="w-6 shrink-0" />
                                  )
                                ) : null}

                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      tabIndex={0}
                                      className={cn(
                                        'px-3 py-1.5 text-xs leading-relaxed break-words whitespace-pre-wrap shadow-2xs transition-opacity focus:outline-none',
                                        getMiniBubbleRadiusClasses(isMine, clusterPosition),
                                        isMine
                                          ? 'bg-primary text-primary-foreground'
                                          : 'border bg-muted/60 text-foreground',
                                        item.decryptionFailed ? 'italic opacity-80' : null,
                                        item.sending ? 'opacity-85' : null,
                                        item.sendError
                                          ? 'ring-1 ring-destructive/60 opacity-90'
                                          : null,
                                      )}
                                    >
                                      {item.plaintext}
                                    </div>
                                  </TooltipTrigger>
                                  {exactTooltipTime ? (
                                    <TooltipContent side={isMine ? 'left' : 'right'}>
                                      {exactTooltipTime}
                                    </TooltipContent>
                                  ) : null}
                                </Tooltip>
                              </div>

                              {item.sending ? (
                                <span className="mt-0.5 px-1 text-[10px] text-muted-foreground">
                                  Đang gửi...
                                </span>
                              ) : null}

                              {item.sendError ? (
                                <div className="mt-1 flex items-center gap-1.5 px-1 text-[10px] text-destructive">
                                  <span>Không gửi được</span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleRetryFailedMessage(
                                        item.dto.clientMsgId,
                                        item.plaintext,
                                      )
                                    }
                                    className="inline-flex items-center gap-0.5 font-semibold underline hover:opacity-80"
                                  >
                                    <RotateCcw className="size-2.5" aria-hidden="true" />
                                    <span>Thử lại</span>
                                  </button>
                                </div>
                              ) : null}

                              {isLastReadByPeer ? (
                                <div
                                  aria-label="Đã xem"
                                  className="mt-1 flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground"
                                >
                                  <UserAvatar
                                    fullName={activeMiniConversation.peer.fullName}
                                    avatarUrl={activeMiniConversation.peer.avatarUrl}
                                    size="xs"
                                    className="size-3.5"
                                  />
                                  <span>Đã xem</span>
                                </div>
                              ) : isLatestOwnSentUnread ? (
                                <span
                                  aria-label="Đã gửi"
                                  className="mt-1 px-1 text-[10px] text-muted-foreground"
                                >
                                  Đã gửi
                                </span>
                              ) : null}
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>

                {chatError ? (
                  <p
                    role="alert"
                    className="border-t bg-destructive/5 px-3 py-1.5 text-[11px] font-medium text-destructive"
                  >
                    {chatError}
                  </p>
                ) : null}

                {isViewingPendingRequest ? (
                  <div className="border-t bg-muted/30 p-3 text-center">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        @{activeMiniConversation.peer.handle}
                      </span>{' '}
                      muốn gửi tin nhắn cho bạn.
                    </p>
                    <div className="mt-2 flex items-center justify-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleAcceptPending()}
                        className="h-7 rounded-lg px-3 text-xs"
                      >
                        <Check className="size-3" aria-hidden="true" />
                        <span>Chấp nhận</span>
                      </Button>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleDeclinePending()}
                        className="h-7 rounded-lg px-3 text-xs"
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                        <span>Xóa</span>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <footer className="border-t bg-background p-2.5">
                    {activeMiniConversation.isAwaitingPeerAcceptance ? (
                      <div className="mb-1.5 flex items-center justify-between rounded-lg bg-muted/60 px-2.5 py-1 text-[10px] text-muted-foreground">
                        <span className="truncate">
                          Đang chờ @{activeMiniConversation.peer.handle} chấp nhận
                        </span>
                        <span className="shrink-0 font-semibold text-foreground">
                          Còn {activeMiniConversation.myState.pendingMessagesRemaining}/3 tin
                        </span>
                      </div>
                    ) : null}

                    {recipientHasZeroKeys ? (
                      <div className="rounded-xl border border-dashed bg-muted/40 px-3 py-2 text-center text-[11px] text-muted-foreground">
                        @{activeMiniConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị
                        nào.
                      </div>
                    ) : (
                      <form
                        onSubmit={(e) => void handleSendMessage(e)}
                        className="flex items-end gap-1 rounded-2xl border bg-muted/30 px-2 py-1 focus-within:border-primary/60 focus-within:bg-background"
                      >
                        <EmojiPickerPopover
                          disabled={!activeMiniConversation.canSendMoreMessages}
                          onSelectEmoji={(emoji) => setDraftText((prev) => `${prev}${emoji}`)}
                        />

                        <textarea
                          rows={1}
                          value={draftText}
                          disabled={!activeMiniConversation.canSendMoreMessages}
                          placeholder={
                            activeMiniConversation.canSendMoreMessages
                              ? 'Nhắn tin...'
                              : 'Đã gửi tối đa 3 tin chờ'
                          }
                          onChange={(e) => setDraftText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void handleSendMessage();
                            }
                          }}
                          className="max-h-24 min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        />

                        <Button
                          type="submit"
                          size="sm"
                          disabled={
                            !draftText.trim() || !activeMiniConversation.canSendMoreMessages
                          }
                          className="h-7 rounded-xl px-2.5 text-xs"
                        >
                          <Send className="size-3" aria-hidden="true" />
                        </Button>
                      </form>
                    )}
                  </footer>
                )}
              </>
            )}
          </section>
        )}
      </div>

      <NewMessageModal
        key={newMessageModalOpen ? 'mini-new-msg-open' : 'mini-new-msg-closed'}
        open={newMessageModalOpen}
        onClose={() => setNewMessageModalOpen(false)}
        onSelectRecipient={async (recipientId) => {
          if (chatStore) {
            const conv = await chatStore.openOrCreateDirectConversation(recipientId);
            setIsOpen(true);
            setActiveMiniConvId(conv.public_id);
          }
        }}
      />
    </TooltipProvider>
  );
}
