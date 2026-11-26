'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  BellOff,
  Check,
  Info,
  KeyRound,
  Loader2,
  Lock,
  MessageCircle,
  PenSquare,
  Pin,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { CallActionButtons } from '@/components/calls/call-action-buttons';
import { useCall } from '@/components/calls/call-context';
import { ChatComposerWithMedia } from '@/components/messages/chat-media-composer';
import {
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
import type { PinBackupModalMode } from '@/components/messages/pin-backup-modal';
import { PinnedMessagesBar } from '@/components/messages/pinned-messages-bar';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import type { ConversationSummaryDto } from '@/modules/chat';

const ChatInfoDrawer = dynamic(
  () => import('@/components/messages/chat-info-drawer').then((m) => m.ChatInfoDrawer),
  { ssr: false },
);

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

export interface MessagesViewProps {
  readonly currentUserPublicId: string;
  readonly currentUserHandle: string;
  readonly currentUserFullName: string;
}

export function MessagesView({ currentUserPublicId, currentUserHandle }: MessagesViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const realtime = useRealtimePresence();
  const chatStore = useChatStore();
  const call = useCall();

  const tabQueryParam = searchParams.get('tab');
  const targetToPublicIdParam = searchParams.get('to');
  const targetConversationParam = searchParams.get('conversation');

  const [chatError, setChatError] = React.useState<string | null>(null);
  const [chatNotice, setChatNotice] = React.useState<string | null>(null);
  const [infoDrawerOpen, setInfoDrawerOpen] = React.useState(false);
  const [pinnedListOpen, setPinnedListOpen] = React.useState(false);
  const [newMessageModalOpen, setNewMessageModalOpen] = React.useState(false);
  const [pinModalMode, setPinModalMode] = React.useState<PinBackupModalMode | null>(null);
  const [confirmBlockOpen, setConfirmBlockOpen] = React.useState(false);
  const [confirmDeleteConvTarget, setConfirmDeleteConvTarget] =
    React.useState<ConversationSummaryDto | null>(null);
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
  const handledToParamRef = React.useRef<string | null>(null);
  const handledConvParamRef = React.useRef<string | null>(null);
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
  const conversations =
    activeTab === 'primary'
      ? (chatStore?.primaryConversations ?? EMPTY_CONVERSATIONS)
      : (chatStore?.pendingConversations ?? EMPTY_CONVERSATIONS);
  const hasLoadedCurrentTab =
    activeTab === 'primary'
      ? (chatStore?.hasLoadedPrimary ?? false)
      : (chatStore?.hasLoadedPending ?? false);
  const loadingConversations = (chatStore?.loadingConversations ?? false) && !hasLoadedCurrentTab;
  const pendingCount = chatStore?.pendingCount ?? 0;
  const selectedConversation = chatStore?.selectedConversation ?? null;
  const previewsByConvId = chatStore?.previewsByConvId ?? {};
  const presences = chatStore?.presences ?? {};
  const ownKeyBundle = chatStore?.ownKeyBundle ?? null;
  const serverKeyBackup = chatStore?.serverKeyBackup ?? null;
  const pinSyncState = chatStore?.pinSyncState ?? 'loading';
  const needsMandatoryPinCreate = pinSyncState === 'must_create';
  const needsPinRestore = pinSyncState === 'needs_restore';

  const activeThread =
    selectedConversation && chatStore
      ? chatStore.getThreadState(selectedConversation.public_id)
      : null;
  const activePinnedState =
    selectedConversation && chatStore
      ? chatStore.getPinnedState(selectedConversation.public_id)
      : null;
  const messages = activeThread?.items ?? EMPTY_MESSAGES;
  const loadingInitialMessages =
    Boolean(selectedConversation) &&
    (!activeThread || (activeThread.loadingInitial && !activeThread.hasInitialized));
  const loadingOlderMessages = activeThread?.loadingOlder ?? false;
  const hasOlderMessages = (activeThread?.nextBeforeSeq ?? null) !== null;

  const peerKeyBundle =
    selectedConversation && chatStore
      ? chatStore.getCachedPeerKeyBundle(selectedConversation.peer.public_id)
      : null;

  const refreshOwnE2eeStatus = chatStore?.refreshOwnE2eeStatus;
  const loadConversations = chatStore?.loadConversations;
  const openConversationThread = chatStore?.openConversationThread;
  const openOrCreateDirectConversation = chatStore?.openOrCreateDirectConversation;
  const setActiveTab = chatStore?.setActiveTab;
  const setMessagesViewportActive = chatStore?.setMessagesViewportActive;

  // Đánh dấu khung chat `/messages` đang thực sự mở trên màn hình; tự động hủy ngay khi rời sang Trang chủ `/` hoặc route khác.
  React.useEffect(() => {
    if (!setMessagesViewportActive) {
      return;
    }
    setMessagesViewportActive(true);
    return () => {
      setMessagesViewportActive(false);
    };
  }, [setMessagesViewportActive]);

  // Khởi tạo trạng thái khóa E2EE cá nhân (Singleton — chỉ chạy nếu chưa có trong RAM).
  React.useEffect(() => {
    if (!refreshOwnE2eeStatus) {
      return;
    }
    void refreshOwnE2eeStatus();
  }, [refreshOwnE2eeStatus]);

  // Đồng bộ tab từ URL query param `?tab=pending` nếu có.
  React.useEffect(() => {
    if (!setActiveTab) {
      return;
    }
    if (tabQueryParam === 'pending' && activeTab !== 'pending') {
      setActiveTab('pending');
    }
  }, [activeTab, setActiveTab, tabQueryParam]);

  // Tải danh sách hội thoại: nếu đã có sẵn trong RAM cache thì chạy đồng bộ ngầm (background: true),
  // hiển thị danh sách ngay lập tức mà không nháy "Đang tải hộp thư...".
  React.useEffect(() => {
    if (!loadConversations) {
      return;
    }
    void loadConversations(activeTab, { background: hasLoadedCurrentTab });
  }, [activeTab, hasLoadedCurrentTab, loadConversations]);

  // Xử lý query `?conversation=<convPublicId>` từ thông báo.
  React.useEffect(() => {
    if (
      !targetConversationParam ||
      handledConvParamRef.current === targetConversationParam ||
      !openConversationThread
    ) {
      return;
    }
    const found = conversations.find((c) => c.public_id === targetConversationParam);
    if (found) {
      handledConvParamRef.current = targetConversationParam;
      void openConversationThread(found);
    }
  }, [conversations, openConversationThread, targetConversationParam]);

  // Xử lý query `?to=<userPublicId>` từ nút "Nhắn tin" trên trang cá nhân `/u/[handle]`.
  React.useEffect(() => {
    if (
      !targetToPublicIdParam ||
      handledToParamRef.current === targetToPublicIdParam ||
      targetToPublicIdParam.toLowerCase() === currentUserPublicId.toLowerCase() ||
      !openOrCreateDirectConversation
    ) {
      return;
    }
    handledToParamRef.current = targetToPublicIdParam;
    void openOrCreateDirectConversation(targetToPublicIdParam)
      .then(() => {
        router.replace('/messages', { scroll: false });
      })
      .catch((err) => {
        setChatError(err instanceof Error ? err.message : 'Không thể mở cuộc trò chuyện.');
      });
  }, [currentUserPublicId, openOrCreateDirectConversation, router, targetToPublicIdParam]);

  // Khi đang có `selectedConversation` từ RAM cache, đảm bảo luồng tin nhắn của hội thoại đó đã được mở/đồng bộ ngầm.
  const selectedConvPublicId = selectedConversation?.public_id ?? null;
  React.useEffect(() => {
    if (!selectedConversation || !openConversationThread) {
      return;
    }
    void openConversationThread(selectedConversation);
    // Chỉ kích hoạt khi đổi ID cuộc hội thoại đang chọn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConvPublicId, openConversationThread]);

  // Suy dẫn trực tiếp tin nhắn đang chỉnh sửa: tự động đóng `MessageEditBanner` ngay lập tức (0 cascading render)
  // khi đổi đoạn chat hoặc khi tin bị thu hồi / xóa 1 phía từ tab khác / đạt giới hạn sửa.
  const editingMessage = React.useMemo<DecryptedMessageViewItem | null>(() => {
    if (!editingTarget || !selectedConversation) {
      return null;
    }
    if (editingTarget.conversationPublicId !== selectedConversation.public_id) {
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
  }, [editingTarget, messages, selectedConversation]);

  const replyingMessage = React.useMemo<DecryptedMessageViewItem | null>(() => {
    if (!replyingTarget || !selectedConversation || editingMessage) {
      return null;
    }
    if (replyingTarget.conversationPublicId !== selectedConversation.public_id) {
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
  }, [editingMessage, messages, replyingTarget, selectedConversation]);

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

  // Nhịp cập nhật đồng hồ nhẹ (10 giây/lần) CHỈ khi đang có tin nhắn của mình nằm trong cửa sổ 5 phút
  // để tự động ẩn 2 nút "Chỉnh sửa" và "Thu hồi" đúng thời điểm.
  const hasOwnRecentMessage = React.useMemo(
    () => messages.some((m) => canRecallMessage(m, nowMs)),
    [messages, nowMs],
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

  // Giữ nguyên vị trí cuộn (Scroll Anchoring) khi nạp tin nhắn cũ lên đầu + Cuộn thông minh khi có tin mới.
  React.useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !selectedConversation) {
      return;
    }

    const convId = selectedConversation.public_id;
    const anchor = scrollAnchorRef.current;

    // 1. Scroll Anchoring khi chèn thêm trang tin nhắn cũ hơn (`beforeSeq`) lên đầu danh sách.
    if (anchor && anchor.convId === convId && messages.length > anchor.prevCount) {
      const heightDiff = container.scrollHeight - anchor.prevScrollHeight;
      container.scrollTop = anchor.prevScrollTop + heightDiff;
      scrollAnchorRef.current = null;
      return;
    }

    const latestItem = messages[messages.length - 1];
    const latestKey = latestItem ? `${convId}:${latestItem.dto.clientMsgId}` : `${convId}:empty`;

    // 2. Khi vừa mở cuộc trò chuyện: đặt ngay ở vị trí cuối cùng của cuộc trò chuyện.
    if (lastScrolledConvIdRef.current !== convId) {
      if (activeThread?.hasInitialized) {
        container.scrollTop = container.scrollHeight;
        isNearBottomRef.current = true;
        lastScrolledConvIdRef.current = convId;
        lastBottomItemKeyRef.current = latestKey;
      }
      return;
    }

    // 3. Khi có tin nhắn mới thêm vào đáy: chỉ tự cuộn xuống đáy nếu người dùng tự gửi tin
    //    HOẶC người dùng đang đứng ở gần đáy (`<= 120px`). Tuyệt đối không kéo xuống đáy khi đang đọc tin cũ ở trên.
    if (lastBottomItemKeyRef.current !== latestKey) {
      lastBottomItemKeyRef.current = latestKey;
      if (latestItem?.dto.isOwnMessage || isNearBottomRef.current) {
        container.scrollTop = container.scrollHeight;
        isNearBottomRef.current = true;
      }
    }
  }, [activeThread?.hasInitialized, messages, selectedConversation]);

  const handleMessagesScroll = React.useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || !selectedConversation || !chatStore) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= 120;

    if (
      container.scrollTop <= 64 &&
      hasOlderMessages &&
      !loadingOlderMessages &&
      !scrollAnchorRef.current
    ) {
      scrollAnchorRef.current = {
        convId: selectedConversation.public_id,
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
        prevCount: messages.length,
      };
      void chatStore.loadOlderMessages(selectedConversation.public_id).then((added) => {
        if (!added) {
          scrollAnchorRef.current = null;
        }
      });
    }
  }, [chatStore, hasOlderMessages, loadingOlderMessages, messages.length, selectedConversation]);

  function handleStartEditMessage(item: DecryptedMessageViewItem) {
    if (!selectedConversation) {
      return;
    }
    setChatError(null);
    setReplyingTarget(null);
    setEditingTarget({
      conversationPublicId: selectedConversation.public_id,
      messagePublicId: item.dto.public_id,
      clientMsgId: item.dto.clientMsgId,
    });
    setTapSelectedMsg(null);
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
  }

  function handleStartReplyMessage(item: DecryptedMessageViewItem) {
    if (!selectedConversation) {
      return;
    }
    setChatError(null);
    setEditingTarget(null);
    setReplyingTarget({
      conversationPublicId: selectedConversation.public_id,
      messagePublicId: item.dto.public_id,
      clientMsgId: item.dto.clientMsgId,
    });
    setTapSelectedMsg(null);
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
  }

  async function handleReactToMessage(item: DecryptedMessageViewItem, emoji: string | null) {
    if (!selectedConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      await chatStore.reactToMessage({
        conversationPublicId: selectedConversation.public_id,
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
    if (!selectedConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      if (item.dto.isPinned) {
        await chatStore.unpinMessage({
          conversationPublicId: selectedConversation.public_id,
          messagePublicId: item.dto.public_id,
        });
        showTransientNotice('Đã gỡ ghim tin nhắn');
        return;
      }

      const outcome = await chatStore.pinMessage({
        conversationPublicId: selectedConversation.public_id,
        messagePublicId: item.dto.public_id,
      });
      if (outcome.ok) {
        showTransientNotice('Đã ghim tin nhắn');
        return;
      }

      if (outcome.limitReached && outcome.hiddenPinnedCount > 0) {
        setDialogError(null);
        setConfirmReplaceHiddenPinTarget({
          conversationPublicId: selectedConversation.public_id,
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
    if (!selectedConversation || !chatStore) {
      return;
    }
    const result = await chatStore.jumpToMessageInConversation(
      selectedConversation.public_id,
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
    if (!selectedConversation || !confirmRecallTarget || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setDialogError(null);
    try {
      await chatStore.recallMessage({
        conversationPublicId: selectedConversation.public_id,
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
    if (!selectedConversation || !chatStore) {
      return;
    }
    setChatError(null);
    if (editingMessage?.dto.public_id === item.dto.public_id) {
      handleCancelEditMessage();
    }
    setTapSelectedMsg(null);
    try {
      await chatStore.deleteMessageForMe({
        conversationPublicId: selectedConversation.public_id,
        messagePublicId: item.dto.public_id,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể xóa tin nhắn lúc này.');
    }
  }

  async function handleConfirmDeleteConversation() {
    if (!confirmDeleteConvTarget || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setDialogError(null);
    try {
      const targetId = confirmDeleteConvTarget.public_id;
      await chatStore.deleteConversationForMe(targetId);
      setConfirmDeleteConvTarget(null);
      if (selectedConversation?.public_id === targetId) {
        setInfoDrawerOpen(false);
        setEditingTarget(null);
      }
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Không thể xóa đoạn chat lúc này.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSendMessage(rawSubmittedText: string): Promise<boolean> {
    if (!selectedConversation || !chatStore) {
      return false;
    }

    const trimmed = rawSubmittedText.trim();
    if (!trimmed) {
      return false;
    }

    if (editingMessage) {
      if (editSaving) {
        return false;
      }
      if (trimmed === editingMessage.plaintext.trim()) {
        handleCancelEditMessage();
        return true;
      }
      setEditSaving(true);
      setChatError(null);
      try {
        await chatStore.editTextMessage({
          conversation: selectedConversation,
          message: editingMessage,
          newPlaintext: trimmed,
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

    if (!selectedConversation.canSendMoreMessages) {
      setChatError(
        'Bạn chỉ có thể gửi tối đa 3 tin nhắn trước khi người nhận chấp nhận cuộc trò chuyện.',
      );
      return false;
    }

    if (peerKeyBundle && peerKeyBundle.devices.length === 0) {
      setChatError(
        `@${selectedConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào. Bạn có thể nhắn tin khi họ trực tuyến.`,
      );
      return false;
    }

    setChatError(null);
    const replyPayload = replyingMessage ? buildReplyPayloadFromMessage(replyingMessage) : null;
    setReplyingTarget(null);
    isNearBottomRef.current = true;

    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: selectedConversation,
        plaintext: trimmed,
        replyTo: replyPayload,
      });
      return true;
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể gửi tin nhắn lúc này.');
      return true;
    }
  }

  async function handleRetryFailedMessage(clientMsgId: string, plaintext: string) {
    if (!selectedConversation || !chatStore) {
      return;
    }
    setChatError(null);
    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: selectedConversation,
        plaintext,
        retryClientMsgId: clientMsgId,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể gửi tin nhắn lúc này.');
    }
  }

  async function handleAcceptRequest() {
    if (!selectedConversation || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      await chatStore.acceptSelectedPendingConversation(selectedConversation.public_id);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể thực hiện thao tác.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeclineRequest() {
    if (!selectedConversation || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      await chatStore.declineSelectedPendingConversation(selectedConversation.public_id);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể xóa cuộc trò chuyện.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmBlockPeer() {
    if (!selectedConversation || !chatStore || actionBusy) {
      return;
    }
    setActionBusy(true);
    try {
      const peerPublicId = selectedConversation.peer.public_id;
      const targetConvId = selectedConversation.public_id;
      const response = await authFetch(
        `/api/v1/social/blocks/${encodeURIComponent(peerPublicId)}`,
        { method: 'POST' },
      );
      if (response.ok) {
        if (
          call?.activeCall?.peer.public_id === peerPublicId ||
          call?.incomingCall?.caller.public_id === peerPublicId
        ) {
          void call.endActiveCall();
        }
        setConfirmBlockOpen(false);
        setInfoDrawerOpen(false);
        chatStore.removeBlockedPeerConversationLocally(targetConvId);
        router.refresh();
      }
    } finally {
      setActionBusy(false);
    }
  }

  const selectedPeerPresence =
    selectedConversation &&
    selectedConversation.myState.inboxState === 'primary' &&
    !selectedConversation.isAwaitingPeerAcceptance &&
    (realtime?.activeStatusEnabled ?? true)
      ? (presences[selectedConversation.peer.public_id.toLowerCase()] ?? null)
      : null;

  const isViewingPendingRequest = selectedConversation?.myState.inboxState === 'pending';
  const recipientHasZeroKeys = peerKeyBundle !== null && peerKeyBundle.devices.length === 0;

  const effectivePeerLastReadSeq =
    (realtime?.readReceiptsEnabled ?? true) &&
    selectedConversation?.myState.inboxState === 'primary' &&
    !selectedConversation.isAwaitingPeerAcceptance
      ? (selectedConversation?.peerLastReadSeq ?? null)
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

  const ownKeyFingerprints = React.useMemo(
    () => ownKeyBundle?.devices.map((d) => d.keyFingerprint) ?? [],
    [ownKeyBundle],
  );
  const peerKeyFingerprints = React.useMemo(
    () => peerKeyBundle?.devices.map((d) => d.keyFingerprint) ?? [],
    [peerKeyBundle],
  );

  return (
    <TooltipProvider delayDuration={180}>
      <div className="flex h-[calc(100vh-7.5rem)] min-h-[540px] overflow-hidden rounded-2xl border bg-background shadow-sm">
        {/* Cột trái: Danh sách hội thoại & 2 Tab Chính / Tin nhắn đang chờ */}
        <section
          aria-label="Danh sách tin nhắn"
          className={cn(
            'flex w-full flex-col border-r sm:w-80 lg:w-96',
            selectedConversation ? 'hidden sm:flex' : 'flex',
          )}
        >
          <div className="flex items-center justify-between border-b px-4 py-3.5">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-foreground">
                @{currentUserHandle}
              </h1>
            </div>

            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Mã PIN tin nhắn"
                title="Mã PIN tin nhắn"
                onClick={() =>
                  setPinModalMode(
                    needsMandatoryPinCreate
                      ? 'create_mandatory'
                      : needsPinRestore
                        ? 'restore'
                        : 'change',
                  )
                }
                className="relative size-8 rounded-full"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                {needsPinRestore ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 size-2 rounded-full bg-amber-500"
                  />
                ) : null}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Soạn tin nhắn mới"
                title="Tin nhắn mới"
                onClick={() => setNewMessageModalOpen(true)}
                className="size-8 rounded-full"
              >
                <PenSquare className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* 2 Tab: Chính & Tin nhắn đang chờ */}
          <div role="tablist" aria-label="Phân loại hộp thư" className="grid grid-cols-2 border-b">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'primary'}
              onClick={() => chatStore?.setActiveTab('primary')}
              className={cn(
                'border-b-2 py-2.5 text-xs font-semibold transition-colors',
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
                'inline-flex items-center justify-center gap-1.5 border-b-2 py-2.5 text-xs font-semibold transition-colors',
                activeTab === 'pending'
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span>Tin nhắn đang chờ</span>
              {pendingCount > 0 ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              ) : null}
            </button>
          </div>

          {needsPinRestore ? (
            <div className="flex items-center justify-between gap-2 border-b bg-primary/5 px-4 py-2.5">
              <p className="text-xs leading-snug text-foreground">
                Nhập mã PIN để đồng bộ các tin nhắn trước đây
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPinModalMode('restore')}
                className="h-7 shrink-0 rounded-lg px-2.5 text-xs"
              >
                Nhập mã PIN
              </Button>
            </div>
          ) : null}

          {!selectedConversation && chatNotice ? (
            <p
              role="status"
              aria-live="polite"
              className="border-b bg-muted/40 px-4 py-1.5 text-xs font-medium text-foreground"
            >
              {chatNotice}
            </p>
          ) : null}

          {!selectedConversation && chatError ? (
            <p
              role="alert"
              className="border-b bg-destructive/5 px-4 py-2 text-xs font-medium text-destructive"
            >
              {chatError}
            </p>
          ) : null}

          <div className="flex-1 overflow-y-auto">
            {loadingConversations ? (
              <ul role="status" aria-label="Đang tải hộp thư" className="divide-y">
                {Array.from({ length: 6 }, (_, idx) => (
                  <li key={idx} className="flex h-[68px] items-center gap-3 px-4 py-3">
                    <span className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="h-3.5 w-28 animate-pulse rounded bg-muted" />
                        <span className="h-2.5 w-10 animate-pulse rounded bg-muted/70" />
                      </div>
                      <span className="block h-3 w-44 max-w-full animate-pulse rounded bg-muted/70" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : conversations.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <MessageCircle className="size-5" aria-hidden="true" />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">
                  {activeTab === 'primary'
                    ? 'Chưa có cuộc trò chuyện nào'
                    : 'Không có tin nhắn đang chờ'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {activeTab === 'primary'
                    ? 'Hãy gửi lời chào tới bạn bè để bắt đầu trò chuyện.'
                    : 'Tin nhắn từ những người bạn chưa kết nối sẽ xuất hiện tại đây.'}
                </p>
                {activeTab === 'primary' ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setNewMessageModalOpen(true)}
                    className="mt-4 h-8 rounded-lg text-xs"
                  >
                    Gửi tin nhắn
                  </Button>
                ) : null}
              </div>
            ) : (
              <ul className="divide-y">
                {conversations.map((conv) => {
                  const isSelected = selectedConversation?.public_id === conv.public_id;
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
                      className={cn(
                        'group/conv flex items-center transition-colors hover:bg-muted/50',
                        isSelected ? 'bg-muted/80' : null,
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setChatError(null);
                          void chatStore?.openConversationThread(conv);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 pr-2 text-left"
                      >
                        <div className="relative shrink-0">
                          <UserAvatar
                            fullName={conv.peer.fullName}
                            avatarUrl={conv.peer.avatarUrl}
                            size="md"
                          />
                          {peerPres?.isOnline ? (
                            <span
                              aria-label="Đang hoạt động"
                              className="absolute bottom-0 right-0 size-3 rounded-full bg-emerald-500 ring-2 ring-background"
                            />
                          ) : null}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-1">
                              <p
                                className={cn(
                                  'truncate text-sm text-foreground',
                                  isUnread ? 'font-bold' : 'font-medium',
                                )}
                              >
                                {conv.peer.fullName}
                              </p>
                              {conv.myState.isPinned ? (
                                <Pin
                                  aria-label="Đoạn chat đã ghim"
                                  className="size-3 shrink-0 text-primary"
                                />
                              ) : null}
                              {conv.myState.isMuted ? (
                                <BellOff
                                  aria-label="Đã tắt thông báo"
                                  className="size-3 shrink-0 text-muted-foreground"
                                />
                              ) : null}
                            </div>
                            <span
                              className={cn(
                                'shrink-0 text-[11px]',
                                isUnread
                                  ? 'font-semibold text-foreground'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {formatConversationShortTimeVi(conv.lastMessageAt ?? conv.createdAt)}
                            </span>
                          </div>
                          <p
                            className={cn(
                              'truncate text-xs',
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
                              'size-2.5 shrink-0 rounded-full',
                              conv.myState.isMuted ? 'bg-muted-foreground/45' : 'bg-primary',
                            )}
                          />
                        ) : null}
                      </button>

                      <div className="pr-2">
                        <ConversationActionsMenu
                          peerFullName={conv.peer.fullName}
                          isPinned={Boolean(conv.myState.isPinned)}
                          isMuted={Boolean(conv.myState.isMuted)}
                          canPin={conv.myState.inboxState === 'primary'}
                          showDelete
                          onTogglePin={() => void handleToggleConversationPin(conv)}
                          onToggleMute={() => void handleToggleConversationMute(conv)}
                          onRequestDeleteConversation={() => {
                            setDialogError(null);
                            setConfirmDeleteConvTarget(conv);
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Cột phải: Khung trò chuyện */}
        <section
          aria-label="Nội dung cuộc trò chuyện"
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            selectedConversation ? 'flex' : 'hidden sm:flex',
          )}
        >
          {!selectedConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <div className="flex size-16 items-center justify-center rounded-full border-2 border-foreground/80 text-foreground">
                <MessageCircle className="size-7" aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-foreground">Tin nhắn của bạn</h2>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Gửi tin nhắn riêng tư và trò chuyện trực tiếp với bạn bè trên Tomato.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => setNewMessageModalOpen(true)}
                className="mt-5 rounded-lg"
              >
                Gửi tin nhắn
              </Button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {/* Thanh tiêu đề đoạn chat */}
                <header className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Quay lại danh sách"
                      onClick={() => chatStore?.selectConversation(null)}
                      className="size-8 rounded-full sm:hidden"
                    >
                      <ArrowLeft className="size-4" aria-hidden="true" />
                    </Button>

                    <Link
                      href={`/u/${encodeURIComponent(selectedConversation.peer.handle)}`}
                      className="flex min-w-0 items-center gap-3 rounded-lg transition-opacity hover:opacity-90"
                    >
                      <div className="relative shrink-0">
                        <UserAvatar
                          fullName={selectedConversation.peer.fullName}
                          avatarUrl={selectedConversation.peer.avatarUrl}
                          size="sm"
                        />
                        {selectedPeerPresence?.isOnline ? (
                          <span
                            aria-hidden="true"
                            className="absolute bottom-0 right-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
                          />
                        ) : null}
                      </div>

                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {selectedConversation.peer.fullName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {selectedPeerPresence
                            ? selectedPeerPresence.label
                            : `@${selectedConversation.peer.handle}`}
                        </p>
                      </div>
                    </Link>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <CallActionButtons conversation={selectedConversation} />

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Thông tin đoạn chat"
                      aria-expanded={infoDrawerOpen}
                      onClick={() => setInfoDrawerOpen((prev) => !prev)}
                      className={cn(
                        'size-9 rounded-full',
                        infoDrawerOpen ? 'bg-muted text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      <Info className="size-4.5" aria-hidden="true" />
                    </Button>
                  </div>
                </header>

                {/* Thanh tin nhắn đã ghim thu gọn (tối đa 5 tin) */}
                {!isViewingPendingRequest && !selectedConversation.isAwaitingPeerAcceptance ? (
                  <PinnedMessagesBar
                    pinnedState={activePinnedState}
                    peer={selectedConversation.peer}
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
                        conversationPublicId: selectedConversation.public_id,
                        messagePublicId: msgId,
                      });
                      showTransientNotice('Đã gỡ ghim tin nhắn');
                    }}
                    onRequestPinRestore={() => setPinModalMode('restore')}
                  />
                ) : null}

                {/* Lịch sử tin nhắn (Cuộn lên để tải thêm + Gom cụm bong bóng + Tooltip giờ) */}
                <div
                  ref={messagesContainerRef}
                  onScroll={handleMessagesScroll}
                  className="flex-1 overflow-y-auto px-4 py-5"
                >
                  {loadingOlderMessages ? (
                    <div className="mb-3 flex items-center justify-center py-1">
                      <Loader2
                        aria-label="Đang tải tin nhắn cũ hơn"
                        className="size-4 animate-spin text-muted-foreground"
                      />
                    </div>
                  ) : null}

                  {!hasOlderMessages ? (
                    <div className="mx-auto mb-5 max-w-sm text-center">
                      <UserAvatar
                        fullName={selectedConversation.peer.fullName}
                        avatarUrl={selectedConversation.peer.avatarUrl}
                        size="lg"
                        className="mx-auto"
                      />
                      <p className="mt-2.5 text-sm font-semibold text-foreground">
                        {selectedConversation.peer.fullName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        @{selectedConversation.peer.handle}
                      </p>
                      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
                        <Lock className="size-3" aria-hidden="true" />
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
                    <div className="flex flex-col items-center justify-center gap-2.5 py-8 text-center">
                      <p className="text-xs text-muted-foreground">{activeThread.errorMessage}</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void chatStore?.openConversationThread(selectedConversation, {
                            forceReload: true,
                          })
                        }
                        className="h-8 gap-1.5 rounded-lg px-3 text-xs"
                      >
                        <RotateCcw className="size-3.5" aria-hidden="true" />
                        <span>Thử lại</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {needsPinRestore && hiddenUndecryptedCount > 0 ? (
                        <div className="mx-auto mb-4 flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-2.5">
                          <div className="flex items-center gap-2 text-xs text-foreground">
                            <KeyRound className="size-4 shrink-0 text-primary" aria-hidden="true" />
                            <span>Nhập mã PIN để đồng bộ các tin nhắn trước đây</span>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setPinModalMode('restore')}
                            className="h-7 shrink-0 rounded-lg px-2.5 text-xs"
                          >
                            Nhập mã PIN
                          </Button>
                        </div>
                      ) : pinSyncState === 'synced' && hiddenUndecryptedCount > 0 ? (
                        <p className="mx-auto mb-4 max-w-md text-center text-[11px] text-muted-foreground">
                          Một số tin nhắn cũ hơn không khả dụng trên thiết bị này.
                        </p>
                      ) : null}

                      {clusteredMessages.map((entry, idx) => (
                        <MessageBubbleRow
                          key={entry.item.dto.clientMsgId}
                          entry={entry}
                          index={idx}
                          peer={selectedConversation.peer}
                          currentUserPublicId={currentUserPublicId}
                          conversation={selectedConversation}
                          variant="full"
                          nowMs={nowMs}
                          isBeingEdited={editingMessage?.dto.public_id === entry.item.dto.public_id}
                          isHighlighted={highlightedMessageId === entry.item.dto.public_id}
                          isTapSelected={
                            tapSelectedMsg?.conversationPublicId ===
                              selectedConversation.public_id &&
                            tapSelectedMsg.clientMsgId === entry.item.dto.clientMsgId
                          }
                          onTapToggle={(msgClientId) =>
                            setTapSelectedMsg((prev) =>
                              prev?.conversationPublicId === selectedConversation.public_id &&
                              prev.clientMsgId === msgClientId
                                ? null
                                : {
                                    conversationPublicId: selectedConversation.public_id,
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
                    className="border-t bg-muted/40 px-4 py-1.5 text-xs font-medium text-foreground"
                  >
                    {chatNotice}
                  </p>
                ) : null}

                {chatError ? (
                  <p
                    role="alert"
                    className="border-t bg-destructive/5 px-4 py-2 text-xs font-medium text-destructive"
                  >
                    {chatError}
                  </p>
                ) : null}

                {/* Banner cho người nhận khi cuộc trò chuyện ở mục "Tin nhắn đang chờ" */}
                {isViewingPendingRequest ? (
                  <div className="border-t bg-muted/30 p-4 text-center">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      <span className="font-semibold text-foreground">
                        @{selectedConversation.peer.handle}
                      </span>{' '}
                      muốn gửi tin nhắn cho bạn. Họ sẽ không biết bạn đã xem cho đến khi bạn chấp
                      nhận.
                    </p>
                    <div className="mt-3 flex items-center justify-center gap-2.5">
                      <Button
                        type="button"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleAcceptRequest()}
                        className="h-8 rounded-lg px-4 text-xs"
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                        <span>Chấp nhận</span>
                      </Button>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void handleDeclineRequest()}
                        className="h-8 rounded-lg px-4 text-xs"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        <span>Xóa</span>
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => setConfirmBlockOpen(true)}
                        className="h-8 rounded-lg px-3 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Ban className="size-3.5" aria-hidden="true" />
                        <span>Chặn</span>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <footer className="border-t bg-background p-3">
                    {selectedConversation.isAwaitingPeerAcceptance ? (
                      <div className="mb-2 flex items-center justify-between rounded-xl bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground">
                        <span>
                          Đang chờ @{selectedConversation.peer.handle} chấp nhận tin nhắn (chỉ gửi
                          văn bản)
                        </span>
                        <span className="font-semibold text-foreground">
                          Còn {selectedConversation.myState.pendingMessagesRemaining}/3 tin
                        </span>
                      </div>
                    ) : null}

                    {recipientHasZeroKeys ? (
                      <div className="rounded-xl border border-dashed bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
                        @{selectedConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị
                        nào. Bạn sẽ có thể gửi tin nhắn ngay khi họ đăng nhập.
                      </div>
                    ) : (
                      <ChatComposerWithMedia
                        key={selectedConversation.public_id}
                        canSendMedia={selectedConversation.canSendMedia}
                        canSendMoreMessages={selectedConversation.canSendMoreMessages}
                        editingMessageKey={editingMessage?.dto.public_id ?? null}
                        editingOriginalText={editingMessage?.plaintext ?? null}
                        editSaving={editSaving}
                        replyingTo={
                          replyingMessage
                            ? {
                                recipientLabel: replyingMessage.dto.isOwnMessage
                                  ? 'chính mình'
                                  : selectedConversation.peer.fullName,
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
                            conversation: selectedConversation,
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
                            conversation: selectedConversation,
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
              </div>

              {infoDrawerOpen ? (
                <ChatInfoDrawer
                  open={infoDrawerOpen}
                  currentUserPublicId={currentUserPublicId}
                  currentUserKeyFingerprints={ownKeyFingerprints}
                  peer={selectedConversation.peer}
                  peerKeyFingerprints={peerKeyFingerprints}
                  pinnedCount={activePinnedState?.totalPinnedCount ?? 0}
                  isPinned={Boolean(selectedConversation.myState.isPinned)}
                  isMuted={Boolean(selectedConversation.myState.isMuted)}
                  canPin={selectedConversation.myState.inboxState === 'primary'}
                  onOpenPinnedMessages={
                    !isViewingPendingRequest && !selectedConversation.isAwaitingPeerAcceptance
                      ? () => setPinnedListOpen(true)
                      : undefined
                  }
                  onTogglePin={() => void handleToggleConversationPin(selectedConversation)}
                  onToggleMute={() => void handleToggleConversationMute(selectedConversation)}
                  onClose={() => setInfoDrawerOpen(false)}
                  onRequestDeleteConversation={() => {
                    setDialogError(null);
                    setConfirmDeleteConvTarget(selectedConversation);
                  }}
                  onRequestBlockPeer={() => setConfirmBlockOpen(true)}
                />
              ) : null}
            </div>
          )}
        </section>
      </div>

      <NewMessageModal
        key={newMessageModalOpen ? 'new-msg-open' : 'new-msg-closed'}
        open={newMessageModalOpen}
        onClose={() => setNewMessageModalOpen(false)}
        onSelectRecipient={async (recipientId) => {
          if (chatStore) {
            await chatStore.openOrCreateDirectConversation(recipientId);
          }
        }}
      />

      <PinBackupModal
        key={
          needsMandatoryPinCreate
            ? 'pin-mandatory-create'
            : pinModalMode
              ? `pin-${pinModalMode}`
              : 'pin-closed'
        }
        open={needsMandatoryPinCreate || pinModalMode !== null}
        initialMode={needsMandatoryPinCreate ? 'create_mandatory' : (pinModalMode ?? 'restore')}
        allowClose={!needsMandatoryPinCreate}
        currentUserPublicId={currentUserPublicId}
        existingBackup={serverKeyBackup}
        onClose={() => setPinModalMode(null)}
        onCompleted={async (payload) => {
          await chatStore?.syncAfterPinOperation(payload);
        }}
      />

      {selectedConversation ? (
        <ConfirmDialog
          open={confirmBlockOpen}
          title={`Chặn @${selectedConversation.peer.handle}?`}
          description="Người này sẽ không thể tìm thấy trang cá nhân hay nhắn tin cho bạn trên Tomato. Họ sẽ không nhận được thông báo khi bị chặn."
          confirmLabel="Chặn"
          destructive
          loading={actionBusy}
          onClose={() => {
            if (!actionBusy) {
              setConfirmBlockOpen(false);
            }
          }}
          onConfirm={() => void handleConfirmBlockPeer()}
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
        open={confirmDeleteConvTarget !== null}
        title="Xóa đoạn chat?"
        description="Toàn bộ lịch sử trò chuyện trước thời điểm này sẽ bị xóa khỏi danh sách của bạn. Người kia vẫn giữ nguyên đoạn chat này."
        confirmLabel="Xóa đoạn chat"
        destructive
        loading={actionBusy}
        errorMessage={confirmDeleteConvTarget ? dialogError : null}
        onClose={() => {
          if (!actionBusy) {
            setConfirmDeleteConvTarget(null);
            setDialogError(null);
          }
        }}
        onConfirm={() => void handleConfirmDeleteConversation()}
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
        key={forwardSourceMessage?.dto.public_id ?? 'forward-closed'}
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
