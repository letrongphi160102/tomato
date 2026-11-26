'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BellOff,
  Check,
  KeyRound,
  Loader2,
  Lock,
  Maximize2,
  MessageCircle,
  PenSquare,
  Pin,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';

import { ChatComposerWithMedia } from '@/components/messages/chat-media-composer';
import {
  shouldRenderFloatingMessagesWidget,
  useChatStore,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import { ConversationActionsMenu } from '@/components/messages/conversation-actions-menu';
import type { ImageLightboxTarget } from '@/components/messages/image-lightbox-modal';
import {
  buildReplyPayloadFromMessage,
  canRecallMessage,
  MAX_MESSAGE_EDIT_COUNT,
} from '@/components/messages/message-actions';
import { MessageBubbleRow } from '@/components/messages/message-bubble-row';
import {
  buildClusteredMessageEntries,
  formatConversationShortTimeVi,
  isConversationUnread,
} from '@/components/messages/message-grouping';
import {
  MandatoryPinSetupPanel,
  type PinBackupModalMode,
} from '@/components/messages/pin-backup-modal';
import { PinnedMessagesBar } from '@/components/messages/pinned-messages-bar';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ConversationSummaryDto } from '@/modules/chat';

const ForwardMessageModal = dynamic(
  () => import('@/components/messages/forward-message-modal').then((m) => m.ForwardMessageModal),
  { ssr: false },
);

const ImageLightboxModal = dynamic(
  () => import('@/components/messages/image-lightbox-modal').then((m) => m.ImageLightboxModal),
  { ssr: false },
);

const NewMessageModal = dynamic(
  () => import('@/components/messages/new-message-modal').then((m) => m.NewMessageModal),
  { ssr: false },
);

const PinBackupModal = dynamic(
  () => import('@/components/messages/pin-backup-modal').then((m) => m.PinBackupModal),
  { ssr: false },
);

const EMPTY_CONVERSATIONS: readonly ConversationSummaryDto[] = [];
const EMPTY_MESSAGES: readonly DecryptedMessageViewItem[] = [];

export interface FloatingMessagesWidgetProps {
  readonly defaultOpen?: boolean;
  readonly onCloseWidget?: () => void;
}

export function FloatingMessagesWidget({
  defaultOpen = false,
  onCloseWidget,
}: FloatingMessagesWidgetProps = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const realtime = useRealtimePresence();
  const chatStore = useChatStore();

  const isAllowedOnCurrentRoute = shouldRenderFloatingMessagesWidget(pathname);

  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const [activeMiniConvId, setActiveMiniConvId] = React.useState<string | null>(null);
  const [chatError, setChatError] = React.useState<string | null>(null);
  const [chatNotice, setChatNotice] = React.useState<string | null>(null);
  const [pinnedListOpen, setPinnedListOpen] = React.useState(false);
  const [newMessageModalOpen, setNewMessageModalOpen] = React.useState(false);
  const [pinModalMode, setPinModalMode] = React.useState<PinBackupModalMode | null>(null);
  const [confirmRecallTarget, setConfirmRecallTarget] =
    React.useState<DecryptedMessageViewItem | null>(null);
  const [confirmReplaceHiddenPinTarget, setConfirmReplaceHiddenPinTarget] = React.useState<{
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
    readonly hiddenPinnedCount: number;
  } | null>(null);
  const [forwardSourceMessage, setForwardSourceMessage] =
    React.useState<DecryptedMessageViewItem | null>(null);
  const [replyingTarget, setReplyingTarget] = React.useState<{
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
    readonly clientMsgId: string;
  } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [editingTarget, setEditingTarget] = React.useState<{
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
    readonly clientMsgId: string;
  } | null>(null);
  const [editSaving, setEditSaving] = React.useState(false);
  const [tapSelectedMsg, setTapSelectedMsg] = React.useState<{
    readonly conversationPublicId: string;
    readonly clientMsgId: string;
  } | null>(null);
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  const [actionBusy, setActionBusy] = React.useState(false);
  const [lightboxTarget, setLightboxTarget] = React.useState<ImageLightboxTarget | null>(null);

  const messagesContainerRef = React.useRef<HTMLDivElement | null>(null);
  const composerInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const currentUserPublicId = chatStore?.currentUserPublicId ?? '';
  const serverKeyBackup = chatStore?.serverKeyBackup ?? null;
  const pinSyncState = chatStore?.pinSyncState ?? 'loading';
  const needsMandatoryPinCreate = pinSyncState === 'must_create';
  const needsPinRestore = pinSyncState === 'needs_restore';

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
  const activePinnedState =
    activeMiniConversation && chatStore
      ? chatStore.getPinnedState(activeMiniConversation.public_id)
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

  // Khi nhận sự kiện xóa hội thoại từ tab khác, tự động đặt lại `activeMiniConvId = null` để không bị kẹt ID cũ.
  const subscribeChatEvents = realtime?.subscribeChatEvents;
  React.useEffect(() => {
    if (!subscribeChatEvents) {
      return;
    }
    return subscribeChatEvents((event) => {
      if (event.event === 'chat.conversation.deleted') {
        const deletedConvId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        if (deletedConvId) {
          setActiveMiniConvId((prev) => (prev === deletedConvId ? null : prev));
          setEditingTarget((prev) => (prev?.conversationPublicId === deletedConvId ? null : prev));
        }
      }
    });
  }, [subscribeChatEvents]);

  // Suy dẫn trực tiếp tin nhắn đang chỉnh sửa: tự động đóng `MessageEditBanner` ngay lập tức (0 cascading render)
  // khi đổi/đóng đoạn chat hoặc khi tin bị thu hồi / xóa 1 phía từ tab khác / đạt giới hạn sửa.
  const editingMessage = React.useMemo<DecryptedMessageViewItem | null>(() => {
    if (!editingTarget || !activeMiniConversation) {
      return null;
    }
    if (editingTarget.conversationPublicId !== activeMiniConversation.public_id) {
      return null;
    }
    const latestMatch = messages.find(
      (m) =>
        m.dto.public_id === editingTarget.messagePublicId ||
        m.dto.clientMsgId === editingTarget.clientMsgId,
    );
    if (
      !latestMatch ||
      latestMatch.dto.recalledAt !== null ||
      latestMatch.dto.editCount >= MAX_MESSAGE_EDIT_COUNT
    ) {
      return null;
    }
    return latestMatch;
  }, [activeMiniConversation, editingTarget, messages]);

  const replyingMessage = React.useMemo<DecryptedMessageViewItem | null>(() => {
    if (!replyingTarget || !activeMiniConversation || editingMessage) {
      return null;
    }
    if (replyingTarget.conversationPublicId !== activeMiniConversation.public_id) {
      return null;
    }
    const latestMatch = messages.find(
      (m) =>
        m.dto.public_id === replyingTarget.messagePublicId ||
        m.dto.clientMsgId === replyingTarget.clientMsgId,
    );
    if (!latestMatch || latestMatch.dto.recalledAt !== null || latestMatch.decryptionFailed) {
      return null;
    }
    return latestMatch;
  }, [activeMiniConversation, editingMessage, messages, replyingTarget]);

  React.useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
      }
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const showTransientNotice = React.useCallback((message: string) => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    setChatNotice(message);
    noticeTimerRef.current = setTimeout(() => {
      setChatNotice(null);
      noticeTimerRef.current = null;
    }, 3000);
  }, []);

  // Nhịp cập nhật đồng hồ nhẹ (10 giây/lần) CHỈ khi cửa sổ nổi đang mở đoạn chat có tin của mình trong 5 phút.
  const hasOwnRecentMessage = React.useMemo(
    () =>
      isOpen && Boolean(activeMiniConversation) && messages.some((m) => canRecallMessage(m, nowMs)),
    [activeMiniConversation, isOpen, messages, nowMs],
  );
  React.useEffect(() => {
    if (!hasOwnRecentMessage) {
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const syncVisibilityTimer = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }
      setNowMs(Date.now());
      if (timer === null) {
        timer = setInterval(() => {
          setNowMs(Date.now());
        }, 10_000);
      }
    };
    syncVisibilityTimer();
    document.addEventListener('visibilitychange', syncVisibilityTimer);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibilityTimer);
      if (timer !== null) {
        clearInterval(timer);
      }
    };
  }, [hasOwnRecentMessage]);

  const effectivePeerLastReadSeq =
    (realtime?.readReceiptsEnabled ?? true) &&
    activeMiniConversation?.myState.inboxState === 'primary' &&
    !activeMiniConversation.isAwaitingPeerAcceptance
      ? (activeMiniConversation?.peerLastReadSeq ?? null)
      : null;

  const visibleMessages = React.useMemo(
    () => messages.filter((m) => !m.decryptionFailed),
    [messages],
  );
  const hiddenUndecryptedCount = messages.length - visibleMessages.length;

  const clusteredMessages = React.useMemo(
    () => buildClusteredMessageEntries(visibleMessages, effectivePeerLastReadSeq),
    [effectivePeerLastReadSeq, visibleMessages],
  );

  const hasOpenChildOverlay = Boolean(
    pinnedListOpen ||
    newMessageModalOpen ||
    pinModalMode !== null ||
    confirmRecallTarget !== null ||
    confirmReplaceHiddenPinTarget !== null ||
    forwardSourceMessage !== null ||
    lightboxTarget !== null,
  );

  React.useEffect(() => {
    if (!isOpen || !isAllowedOnCurrentRoute || hasOpenChildOverlay) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (editingMessage || replyingMessage) {
        return;
      }
      if (activeMiniConvId !== null) {
        setChatError(null);
        setActiveMiniConvId(null);
        return;
      }
      setFloatingViewportConversation?.(null);
      setIsOpen(false);
      onCloseWidget?.();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    activeMiniConvId,
    editingMessage,
    hasOpenChildOverlay,
    isAllowedOnCurrentRoute,
    isOpen,
    onCloseWidget,
    replyingMessage,
    setFloatingViewportConversation,
  ]);

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
    onCloseWidget?.();
    router.push('/messages');
  }

  function handleCloseWidget() {
    setFloatingViewportConversation?.(null);
    setActiveMiniConvId(null);
    setIsOpen(false);
    setChatError(null);
    setChatNotice(null);
    setEditingTarget(null);
    setReplyingTarget(null);
    setPinnedListOpen(false);
    setTapSelectedMsg(null);
    onCloseWidget?.();
  }

  function handleSelectMiniConversation(conv: ConversationSummaryDto) {
    setChatError(null);
    setChatNotice(null);
    setEditingTarget(null);
    setReplyingTarget(null);
    setPinnedListOpen(false);
    setTapSelectedMsg(null);
    setActiveMiniConvId(conv.public_id);
    void chatStore?.openConversationThread(conv);
  }

  function handleStartEditMessage(item: DecryptedMessageViewItem) {
    if (!activeMiniConversation) {
      return;
    }
    setChatError(null);
    setReplyingTarget(null);
    setEditingTarget({
      conversationPublicId: activeMiniConversation.public_id,
      messagePublicId: item.dto.public_id,
      clientMsgId: item.dto.clientMsgId,
    });
    setTapSelectedMsg(null);
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
  }

  function handleStartReplyMessage(item: DecryptedMessageViewItem) {
    if (!activeMiniConversation) {
      return;
    }
    setChatError(null);
    setEditingTarget(null);
    setReplyingTarget({
      conversationPublicId: activeMiniConversation.public_id,
      messagePublicId: item.dto.public_id,
      clientMsgId: item.dto.clientMsgId,
    });
    setTapSelectedMsg(null);
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
  }

  async function handleReactToMessage(item: DecryptedMessageViewItem, emoji: string | null) {
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      await chatStore.reactToMessage({
        conversationPublicId: activeMiniConversation.public_id,
        messagePublicId: item.dto.public_id,
        emoji,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể thả cảm xúc lúc này.');
    }
  }

  async function handleCopyMessage(item: DecryptedMessageViewItem) {
    try {
      await navigator.clipboard.writeText(item.plaintext);
      showTransientNotice('Đã sao chép tin nhắn');
    } catch {
      setChatError('Trình duyệt không cho phép sao chép vào bộ nhớ tạm.');
    }
  }

  async function handleTogglePinMessage(item: DecryptedMessageViewItem) {
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      if (item.dto.isPinned) {
        await chatStore.unpinMessage({
          conversationPublicId: activeMiniConversation.public_id,
          messagePublicId: item.dto.public_id,
        });
        showTransientNotice('Đã gỡ ghim tin nhắn');
        return;
      }

      const outcome = await chatStore.pinMessage({
        conversationPublicId: activeMiniConversation.public_id,
        messagePublicId: item.dto.public_id,
      });
      if (outcome.ok) {
        showTransientNotice('Đã ghim tin nhắn');
        return;
      }

      if (outcome.limitReached && outcome.hiddenPinnedCount > 0) {
        setDialogError(null);
        setConfirmReplaceHiddenPinTarget({
          conversationPublicId: activeMiniConversation.public_id,
          messagePublicId: item.dto.public_id,
          hiddenPinnedCount: outcome.hiddenPinnedCount,
        });
        return;
      }

      setChatError(outcome.message);
      if (outcome.limitReached) {
        setPinnedListOpen(true);
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể cập nhật ghim tin nhắn.');
    }
  }

  async function handleConfirmReplaceHiddenPin() {
    if (!confirmReplaceHiddenPinTarget || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setDialogError(null);
    try {
      const outcome = await chatStore.pinMessage({
        conversationPublicId: confirmReplaceHiddenPinTarget.conversationPublicId,
        messagePublicId: confirmReplaceHiddenPinTarget.messagePublicId,
        unpinOldestHiddenIfFull: true,
      });
      if (outcome.ok) {
        setConfirmReplaceHiddenPinTarget(null);
        showTransientNotice('Đã gỡ ghim tin cũ và ghim tin nhắn mới');
      } else {
        setDialogError(outcome.message);
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function handleToggleConversationPin(conv: ConversationSummaryDto) {
    if (!chatStore) {
      return;
    }
    setChatError(null);
    try {
      const nextPinned = !conv.myState.isPinned;
      await chatStore.updateConversationPreferences({
        conversationPublicId: conv.public_id,
        pinned: nextPinned,
      });
      showTransientNotice(nextPinned ? 'Đã ghim đoạn chat' : 'Đã bỏ ghim đoạn chat');
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Không thể cập nhật ghim đoạn chat lúc này.',
      );
    }
  }

  async function handleToggleConversationMute(conv: ConversationSummaryDto) {
    if (!chatStore) {
      return;
    }
    setChatError(null);
    try {
      const nextMuted = !conv.myState.isMuted;
      await chatStore.updateConversationPreferences({
        conversationPublicId: conv.public_id,
        muted: nextMuted,
      });
      showTransientNotice(nextMuted ? 'Đã tắt thông báo đoạn chat' : 'Đã bật thông báo đoạn chat');
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Không thể cập nhật thông báo đoạn chat lúc này.',
      );
    }
  }

  async function handleJumpToMessage(targetMessagePublicId: string) {
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    const result = await chatStore.jumpToMessageInConversation(
      activeMiniConversation.public_id,
      targetMessagePublicId,
    );
    if (result.status !== 'found') {
      showTransientNotice(result.notice);
      return;
    }

    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      const targetEl = container?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(targetMessagePublicId)}"]`,
      );
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedMessageId(targetMessagePublicId);
        if (highlightTimerRef.current !== null) {
          clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = setTimeout(() => {
          setHighlightedMessageId(null);
          highlightTimerRef.current = null;
        }, 2000);
      }
    });
  }

  function handleCancelEditMessage() {
    setEditingTarget(null);
    setChatError(null);
  }

  async function handleConfirmRecallMessage() {
    if (!activeMiniConversation || !confirmRecallTarget || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setDialogError(null);
    try {
      await chatStore.recallMessage({
        conversationPublicId: activeMiniConversation.public_id,
        messagePublicId: confirmRecallTarget.dto.public_id,
      });
      if (editingMessage?.dto.public_id === confirmRecallTarget.dto.public_id) {
        handleCancelEditMessage();
      }
      setConfirmRecallTarget(null);
      setTapSelectedMsg(null);
    } catch (error) {
      setDialogError(
        error instanceof Error ? error.message : 'Không thể thu hồi tin nhắn lúc này.',
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeleteMessageForMe(item: DecryptedMessageViewItem) {
    if (!activeMiniConversation || !chatStore) {
      return;
    }
    setChatError(null);
    if (editingMessage?.dto.public_id === item.dto.public_id) {
      handleCancelEditMessage();
    }
    setTapSelectedMsg(null);
    try {
      await chatStore.deleteMessageForMe({
        conversationPublicId: activeMiniConversation.public_id,
        messagePublicId: item.dto.public_id,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể xóa tin nhắn lúc này.');
    }
  }

  async function handleSendMessage(rawSubmittedText: string): Promise<boolean> {
    if (!activeMiniConversation || !chatStore) {
      return false;
    }
    const textToSend = rawSubmittedText.trim();
    if (!textToSend) {
      return false;
    }

    if (editingMessage) {
      if (editSaving) {
        return false;
      }
      if (textToSend === editingMessage.plaintext.trim()) {
        handleCancelEditMessage();
        return true;
      }
      setEditSaving(true);
      setChatError(null);
      try {
        await chatStore.editTextMessage({
          conversation: activeMiniConversation,
          message: editingMessage,
          newPlaintext: textToSend,
        });
        setEditingTarget(null);
        return true;
      } catch (error) {
        setChatError(
          error instanceof Error ? error.message : 'Không thể chỉnh sửa tin nhắn lúc này.',
        );
        return false;
      } finally {
        setEditSaving(false);
      }
    }

    const replyPayload = replyingMessage ? buildReplyPayloadFromMessage(replyingMessage) : null;
    setReplyingTarget(null);
    setChatError(null);
    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: activeMiniConversation,
        plaintext: textToSend,
        replyTo: replyPayload,
      });
      return true;
    } catch (error) {
      setChatError(
        error instanceof Error ? error.message : 'Không thể gửi tin nhắn. Vui lòng thử lại.',
      );
      return true;
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
            {needsMandatoryPinCreate && currentUserPublicId ? (
              <>
                <header className="flex items-center justify-between border-b px-4 py-3">
                  <h2 className="text-sm font-bold text-foreground">Tin nhắn</h2>
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
                </header>
                <MandatoryPinSetupPanel
                  currentUserPublicId={currentUserPublicId}
                  compact
                  onCompleted={async (payload) => {
                    await chatStore?.syncAfterPinOperation(payload);
                  }}
                />
              </>
            ) : !activeMiniConversation ? (
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

                {needsPinRestore ? (
                  <div className="flex items-center justify-between gap-2 border-b bg-primary/5 px-3 py-2">
                    <p className="text-[11px] leading-snug text-foreground">
                      Nhập mã PIN để đồng bộ các tin nhắn trước đây
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPinModalMode('restore')}
                      className="h-6 shrink-0 rounded-lg px-2 text-[11px]"
                    >
                      Nhập mã PIN
                    </Button>
                  </div>
                ) : null}

                {chatNotice ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="border-b bg-muted/40 px-3 py-1 text-[11px] font-medium text-foreground"
                  >
                    {chatNotice}
                  </p>
                ) : null}

                {chatError ? (
                  <p
                    role="alert"
                    className="border-b bg-destructive/5 px-3 py-1.5 text-[11px] font-medium text-destructive"
                  >
                    {chatError}
                  </p>
                ) : null}

                {/* Danh sách hội thoại */}
                <div className="relative flex-1 overflow-y-auto">
                  {loadingConversations ? (
                    <ul role="status" aria-label="Đang tải hộp thư" className="divide-y pb-14">
                      {Array.from({ length: 5 }, (_, idx) => (
                        <li key={idx} className="flex h-[58px] items-center gap-3 px-3.5 py-2.5">
                          <span className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="h-3 w-24 animate-pulse rounded bg-muted" />
                              <span className="h-2.5 w-8 animate-pulse rounded bg-muted/70" />
                            </div>
                            <span className="block h-2.5 w-36 max-w-full animate-pulse rounded bg-muted/70" />
                          </div>
                        </li>
                      ))}
                    </ul>
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
                          <li
                            key={conv.public_id}
                            className="group/conv flex items-center transition-colors hover:bg-muted/50"
                          >
                            <button
                              type="button"
                              onClick={() => handleSelectMiniConversation(conv)}
                              className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3.5 pr-1.5 text-left"
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
                                  <div className="flex min-w-0 items-center gap-1">
                                    <p
                                      className={cn(
                                        'truncate text-xs text-foreground',
                                        isUnread ? 'font-bold' : 'font-medium',
                                      )}
                                    >
                                      {conv.peer.fullName}
                                    </p>
                                    {conv.myState.isPinned ? (
                                      <Pin
                                        aria-label="Đoạn chat đã ghim"
                                        className="size-2.5 shrink-0 text-primary"
                                      />
                                    ) : null}
                                    {conv.myState.isMuted ? (
                                      <BellOff
                                        aria-label="Đã tắt thông báo"
                                        className="size-2.5 shrink-0 text-muted-foreground"
                                      />
                                    ) : null}
                                  </div>
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
                                  className={cn(
                                    'size-2 shrink-0 rounded-full',
                                    conv.myState.isMuted ? 'bg-muted-foreground/45' : 'bg-primary',
                                  )}
                                />
                              ) : null}
                            </button>

                            <div className="pr-1.5">
                              <ConversationActionsMenu
                                peerFullName={conv.peer.fullName}
                                compact
                                isPinned={Boolean(conv.myState.isPinned)}
                                isMuted={Boolean(conv.myState.isMuted)}
                                canPin={conv.myState.inboxState === 'primary'}
                                showDelete={false}
                                onTogglePin={() => void handleToggleConversationPin(conv)}
                                onToggleMute={() => void handleToggleConversationMute(conv)}
                              />
                            </div>
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

                  <div className="flex shrink-0 items-center gap-0.5">
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

                {/* Thanh tin nhắn đã ghim thu gọn (đồng bộ 100% với /messages) */}
                {!isViewingPendingRequest && !activeMiniConversation.isAwaitingPeerAcceptance ? (
                  <PinnedMessagesBar
                    pinnedState={activePinnedState}
                    peer={activeMiniConversation.peer}
                    compact
                    needsPinRestore={needsPinRestore}
                    listOpen={pinnedListOpen}
                    onOpenList={() => setPinnedListOpen(true)}
                    onCloseList={() => setPinnedListOpen(false)}
                    onJumpToMessage={(msgId) => void handleJumpToMessage(msgId)}
                    onUnpinMessage={async (msgId) => {
                      if (!chatStore) {
                        return;
                      }
                      await chatStore.unpinMessage({
                        conversationPublicId: activeMiniConversation.public_id,
                        messagePublicId: msgId,
                      });
                      showTransientNotice('Đã gỡ ghim tin nhắn');
                    }}
                    onRequestPinRestore={() => setPinModalMode('restore')}
                  />
                ) : null}

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
                      {needsPinRestore && hiddenUndecryptedCount > 0 ? (
                        <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-[11px] leading-snug text-foreground">
                            <KeyRound
                              className="size-3.5 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                            <span>Nhập mã PIN để đồng bộ các tin nhắn trước đây</span>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setPinModalMode('restore')}
                            className="h-6 shrink-0 rounded-lg px-2 text-[11px]"
                          >
                            Nhập mã PIN
                          </Button>
                        </div>
                      ) : pinSyncState === 'synced' && hiddenUndecryptedCount > 0 ? (
                        <p className="mb-3 text-center text-[10px] text-muted-foreground">
                          Một số tin nhắn cũ hơn không khả dụng trên thiết bị này.
                        </p>
                      ) : null}

                      {clusteredMessages.map((entry, idx) => (
                        <MessageBubbleRow
                          key={entry.item.dto.clientMsgId}
                          entry={entry}
                          index={idx}
                          peer={activeMiniConversation.peer}
                          currentUserPublicId={currentUserPublicId}
                          conversation={activeMiniConversation}
                          variant="compact"
                          nowMs={nowMs}
                          isBeingEdited={editingMessage?.dto.public_id === entry.item.dto.public_id}
                          isHighlighted={highlightedMessageId === entry.item.dto.public_id}
                          isTapSelected={
                            tapSelectedMsg?.conversationPublicId ===
                              activeMiniConversation.public_id &&
                            tapSelectedMsg.clientMsgId === entry.item.dto.clientMsgId
                          }
                          onTapToggle={(msgClientId) =>
                            setTapSelectedMsg((prev) =>
                              prev?.conversationPublicId === activeMiniConversation.public_id &&
                              prev.clientMsgId === msgClientId
                                ? null
                                : {
                                    conversationPublicId: activeMiniConversation.public_id,
                                    clientMsgId: msgClientId,
                                  },
                            )
                          }
                          onReact={(item, emoji) => void handleReactToMessage(item, emoji)}
                          onReply={handleStartReplyMessage}
                          onForward={(item) => setForwardSourceMessage(item)}
                          onCopy={(item) => void handleCopyMessage(item)}
                          onTogglePin={(item) => void handleTogglePinMessage(item)}
                          onJumpToMessage={(targetMsgId) => void handleJumpToMessage(targetMsgId)}
                          onStartEdit={handleStartEditMessage}
                          onRequestRecall={(item) => {
                            setDialogError(null);
                            setConfirmRecallTarget(item);
                          }}
                          onDeleteForMe={(item) => void handleDeleteMessageForMe(item)}
                          onRetryFailed={(clientMsgId, plaintext) =>
                            void handleRetryFailedMessage(clientMsgId, plaintext)
                          }
                          onOpenLightbox={(target) => setLightboxTarget(target)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {chatNotice ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="border-t bg-muted/40 px-3 py-1 text-[11px] font-medium text-foreground"
                  >
                    {chatNotice}
                  </p>
                ) : null}

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
                      <ChatComposerWithMedia
                        key={activeMiniConversation.public_id}
                        compact
                        canSendMedia={activeMiniConversation.canSendMedia}
                        canSendMoreMessages={activeMiniConversation.canSendMoreMessages}
                        editingMessageKey={editingMessage?.dto.public_id ?? null}
                        editingOriginalText={editingMessage?.plaintext ?? null}
                        editSaving={editSaving}
                        replyingTo={
                          replyingMessage
                            ? {
                                recipientLabel: replyingMessage.dto.isOwnMessage
                                  ? 'chính mình'
                                  : activeMiniConversation.peer.fullName,
                                previewText:
                                  replyingMessage.dto.messageType === 'image'
                                    ? 'Hình ảnh'
                                    : replyingMessage.dto.messageType === 'voice'
                                      ? 'Tin nhắn thoại'
                                      : replyingMessage.plaintext,
                              }
                            : null
                        }
                        composerInputRef={composerInputRef}
                        onCancelEdit={handleCancelEditMessage}
                        onCancelReply={() => setReplyingTarget(null)}
                        onSubmitTextOrEdit={handleSendMessage}
                        onSendImageFile={async (file) => {
                          if (!chatStore) {
                            return;
                          }
                          const replyPayload = replyingMessage
                            ? buildReplyPayloadFromMessage(replyingMessage)
                            : null;
                          setReplyingTarget(null);
                          isNearBottomRef.current = true;
                          await chatStore.sendOptimisticImageMessage({
                            conversation: activeMiniConversation,
                            file,
                            replyTo: replyPayload,
                          });
                        }}
                        onSendVoice={async (recorded) => {
                          if (!chatStore) {
                            return;
                          }
                          const replyPayload = replyingMessage
                            ? buildReplyPayloadFromMessage(replyingMessage)
                            : null;
                          setReplyingTarget(null);
                          isNearBottomRef.current = true;
                          await chatStore.sendOptimisticVoiceMessage({
                            conversation: activeMiniConversation,
                            audioBlob: recorded.audioBlob,
                            mimeType: recorded.mimeType,
                            durationMs: recorded.durationMs,
                            waveform: recorded.waveform,
                            replyTo: replyPayload,
                          });
                        }}
                        onError={setChatError}
                      />
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

      {currentUserPublicId ? (
        <PinBackupModal
          key={pinModalMode ? `mini-pin-${pinModalMode}` : 'mini-pin-closed'}
          open={pinModalMode !== null}
          initialMode={pinModalMode ?? 'restore'}
          allowClose
          currentUserPublicId={currentUserPublicId}
          existingBackup={serverKeyBackup}
          onClose={() => setPinModalMode(null)}
          onCompleted={async (payload) => {
            await chatStore?.syncAfterPinOperation(payload);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmRecallTarget !== null}
        title="Thu hồi tin nhắn?"
        description="Tin nhắn này sẽ bị thu hồi với mọi người trong cuộc trò chuyện. Bạn không thể hoàn tác thao tác này."
        confirmLabel="Thu hồi"
        destructive
        loading={actionBusy}
        errorMessage={confirmRecallTarget ? dialogError : null}
        onClose={() => {
          if (!actionBusy) {
            setConfirmRecallTarget(null);
            setDialogError(null);
          }
        }}
        onConfirm={() => void handleConfirmRecallMessage()}
      />

      <ConfirmDialog
        open={confirmReplaceHiddenPinTarget !== null}
        title="Danh sách tin nhắn đã ghim đã đầy"
        description={`Cuộc trò chuyện đang có tối đa 5 tin nhắn được ghim (bao gồm ${confirmReplaceHiddenPinTarget?.hiddenPinnedCount ?? 1} tin cũ không còn hiển thị ở phía bạn). Bạn có muốn gỡ ghim tin cũ nhất để ghim tin nhắn này không?`}
        confirmLabel="Gỡ tin cũ và ghim"
        loading={actionBusy}
        errorMessage={confirmReplaceHiddenPinTarget ? dialogError : null}
        onClose={() => {
          if (!actionBusy) {
            setConfirmReplaceHiddenPinTarget(null);
            setDialogError(null);
          }
        }}
        onConfirm={() => void handleConfirmReplaceHiddenPin()}
      />

      <ForwardMessageModal
        key={forwardSourceMessage?.dto.public_id ?? 'mini-forward-closed'}
        open={forwardSourceMessage !== null}
        sourceMessage={forwardSourceMessage}
        onClose={() => setForwardSourceMessage(null)}
        onConfirmForward={async (sourceMessage, recipients) => {
          if (!chatStore) {
            return { succeeded: [], failed: [] };
          }
          const result = await chatStore.forwardMessageToRecipients({
            sourceMessage,
            recipients,
          });
          if (result.succeeded.length > 0 && result.failed.length === 0) {
            showTransientNotice(
              result.succeeded.length === 1
                ? `Đã chuyển tiếp tới ${result.succeeded[0]!.target.fullName}`
                : `Đã chuyển tiếp tới ${result.succeeded.length} người`,
            );
          }
          return result;
        }}
      />

      <ImageLightboxModal target={lightboxTarget} onClose={() => setLightboxTarget(null)} />
    </TooltipProvider>
  );
}
