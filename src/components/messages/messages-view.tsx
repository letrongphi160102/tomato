'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  Check,
  Image as ImageIcon,
  Info,
  KeyRound,
  Loader2,
  Lock,
  MessageCircle,
  Mic,
  PenSquare,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';

import { ChatInfoDrawer } from '@/components/messages/chat-info-drawer';
import {
  useChatStore,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import { ConversationActionsMenu } from '@/components/messages/conversation-actions-menu';
import { EmojiPickerPopover } from '@/components/messages/emoji-picker-popover';
import { canRecallMessage, MAX_MESSAGE_EDIT_COUNT } from '@/components/messages/message-actions';
import { MessageBubbleRow } from '@/components/messages/message-bubble-row';
import { MessageEditBanner } from '@/components/messages/message-edit-banner';
import {
  buildClusteredMessageEntries,
  formatConversationShortTimeVi,
  isConversationUnread,
} from '@/components/messages/message-grouping';
import { NewMessageModal } from '@/components/messages/new-message-modal';
import { PinBackupModal } from '@/components/messages/pin-backup-modal';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import type { ConversationSummaryDto } from '@/modules/chat';

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

  const tabQueryParam = searchParams.get('tab');
  const targetToPublicIdParam = searchParams.get('to');
  const targetConversationParam = searchParams.get('conversation');

  const [draftText, setDraftText] = React.useState('');
  const [editDraftText, setEditDraftText] = React.useState('');
  const [chatError, setChatError] = React.useState<string | null>(null);
  const [infoDrawerOpen, setInfoDrawerOpen] = React.useState(false);
  const [newMessageModalOpen, setNewMessageModalOpen] = React.useState(false);
  const [pinModalOpen, setPinModalOpen] = React.useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = React.useState(false);
  const [confirmDeleteConvTarget, setConfirmDeleteConvTarget] =
    React.useState<ConversationSummaryDto | null>(null);
  const [confirmRecallTarget, setConfirmRecallTarget] =
    React.useState<DecryptedMessageViewItem | null>(null);
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

  const messagesContainerRef = React.useRef<HTMLDivElement | null>(null);
  const composerInputRef = React.useRef<HTMLTextAreaElement | null>(null);
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
  const hasLocalRestoredBackup = chatStore?.hasLocalRestoredBackup ?? false;

  const activeThread =
    selectedConversation && chatStore
      ? chatStore.getThreadState(selectedConversation.public_id)
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
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 10_000);
    return () => clearInterval(timer);
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
    setEditingTarget({
      conversationPublicId: selectedConversation.public_id,
      messagePublicId: item.dto.public_id,
      clientMsgId: item.dto.clientMsgId,
    });
    setEditDraftText(item.plaintext);
    setTapSelectedMsg(null);
    setTimeout(() => {
      composerInputRef.current?.focus();
    }, 0);
  }

  function handleCancelEditMessage() {
    setEditingTarget(null);
    setEditDraftText('');
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
        setEditDraftText('');
        setDraftText('');
      }
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Không thể xóa đoạn chat lúc này.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selectedConversation || !chatStore) {
      return;
    }

    const activeInputText = editingMessage ? editDraftText : draftText;
    const trimmed = activeInputText.trim();
    if (!trimmed) {
      return;
    }

    if (editingMessage) {
      if (editSaving) {
        return;
      }
      if (trimmed === editingMessage.plaintext.trim()) {
        handleCancelEditMessage();
        return;
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
        setEditDraftText('');
      } catch (error) {
        setChatError(
          error instanceof Error ? error.message : 'Không thể chỉnh sửa tin nhắn lúc này.',
        );
      } finally {
        setEditSaving(false);
      }
      return;
    }

    if (!selectedConversation.canSendMoreMessages) {
      setChatError(
        'Bạn chỉ có thể gửi tối đa 3 tin nhắn trước khi người nhận chấp nhận cuộc trò chuyện.',
      );
      return;
    }

    if (peerKeyBundle && peerKeyBundle.devices.length === 0) {
      setChatError(
        `@${selectedConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào. Bạn có thể nhắn tin khi họ trực tuyến.`,
      );
      return;
    }

    setChatError(null);
    setDraftText('');
    isNearBottomRef.current = true;

    try {
      await chatStore.sendOptimisticTextMessage({
        conversation: selectedConversation,
        plaintext: trimmed,
      });
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể gửi tin nhắn lúc này.');
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

  const clusteredMessages = React.useMemo(
    () => buildClusteredMessageEntries(messages, effectivePeerLastReadSeq),
    [effectivePeerLastReadSeq, messages],
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
                aria-label="Đồng bộ tin nhắn bằng mã PIN"
                title="Đồng bộ tin nhắn"
                onClick={() => setPinModalOpen(true)}
                className="relative size-8 rounded-full"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                {serverKeyBackup && !hasLocalRestoredBackup ? (
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

          {serverKeyBackup && !hasLocalRestoredBackup ? (
            <div className="flex items-center justify-between gap-2 border-b bg-primary/5 px-4 py-2.5">
              <p className="text-xs text-foreground">
                Nhập mã PIN để đồng bộ tin nhắn từ thiết bị trước của bạn.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPinModalOpen(true)}
                className="h-7 shrink-0 rounded-lg px-2.5 text-xs"
              >
                Nhập PIN
              </Button>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto">
            {loadingConversations ? (
              <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                <span>Đang tải hộp thư...</span>
              </div>
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
                            <p
                              className={cn(
                                'truncate text-sm text-foreground',
                                isUnread ? 'font-bold' : 'font-medium',
                              )}
                            >
                              {conv.peer.fullName}
                            </p>
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
                            className="size-2.5 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                      </button>

                      <div className="pr-2">
                        <ConversationActionsMenu
                          peerFullName={conv.peer.fullName}
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
                </header>

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
                      {clusteredMessages.map((entry, idx) => (
                        <MessageBubbleRow
                          key={entry.item.dto.clientMsgId}
                          entry={entry}
                          index={idx}
                          peer={selectedConversation.peer}
                          variant="full"
                          nowMs={nowMs}
                          isBeingEdited={editingMessage?.dto.public_id === entry.item.dto.public_id}
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
                          onStartEdit={handleStartEditMessage}
                          onRequestRecall={(item) => {
                            setDialogError(null);
                            setConfirmRecallTarget(item);
                          }}
                          onDeleteForMe={(item) => void handleDeleteMessageForMe(item)}
                          onRetryFailed={(clientMsgId, plaintext) =>
                            void handleRetryFailedMessage(clientMsgId, plaintext)
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>

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

                    {editingMessage ? (
                      <MessageEditBanner
                        originalText={editingMessage.plaintext}
                        saving={editSaving}
                        onCancel={handleCancelEditMessage}
                      />
                    ) : null}

                    {recipientHasZeroKeys ? (
                      <div className="rounded-xl border border-dashed bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
                        @{selectedConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị
                        nào. Bạn sẽ có thể gửi tin nhắn ngay khi họ đăng nhập.
                      </div>
                    ) : (
                      <form
                        onSubmit={(e) => void handleSendMessage(e)}
                        className="flex items-end gap-1.5 rounded-2xl border bg-muted/30 px-2.5 py-1.5 focus-within:border-primary/60 focus-within:bg-background"
                      >
                        <EmojiPickerPopover
                          disabled={!editingMessage && !selectedConversation.canSendMoreMessages}
                          onSelectEmoji={(emoji) =>
                            editingMessage
                              ? setEditDraftText((prev) => `${prev}${emoji}`)
                              : setDraftText((prev) => `${prev}${emoji}`)
                          }
                        />

                        {!editingMessage && !selectedConversation.canSendMedia ? (
                          <div className="flex items-center gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled
                              title="Chỉ khả dụng sau khi người nhận chấp nhận cuộc trò chuyện"
                              aria-label="Gửi hình ảnh (đang khóa trong tin nhắn chờ)"
                              className="size-8 rounded-full opacity-40"
                            >
                              <ImageIcon className="size-4" aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled
                              title="Chỉ khả dụng sau khi người nhận chấp nhận cuộc trò chuyện"
                              aria-label="Gửi tin nhắn thoại (đang khóa trong tin nhắn chờ)"
                              className="size-8 rounded-full opacity-40"
                            >
                              <Mic className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        ) : null}

                        <textarea
                          ref={composerInputRef}
                          rows={1}
                          value={editingMessage ? editDraftText : draftText}
                          disabled={
                            editSaving ||
                            (!editingMessage && !selectedConversation.canSendMoreMessages)
                          }
                          placeholder={
                            editingMessage
                              ? 'Nhập nội dung mới...'
                              : selectedConversation.canSendMoreMessages
                                ? 'Nhắn tin...'
                                : 'Đã gửi tối đa 3 tin nhắn đang chờ chấp nhận'
                          }
                          onChange={(e) =>
                            editingMessage
                              ? setEditDraftText(e.target.value)
                              : setDraftText(e.target.value)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Escape' && editingMessage && !editSaving) {
                              e.preventDefault();
                              handleCancelEditMessage();
                              return;
                            }
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void handleSendMessage();
                            }
                          }}
                          className="max-h-28 min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        />

                        <Button
                          type="submit"
                          size="sm"
                          disabled={
                            editSaving ||
                            !(editingMessage ? editDraftText : draftText).trim() ||
                            (!editingMessage && !selectedConversation.canSendMoreMessages)
                          }
                          className="h-8 rounded-xl px-3 text-xs"
                        >
                          {editSaving ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : editingMessage ? (
                            <Check className="size-3.5" aria-hidden="true" />
                          ) : (
                            <Send className="size-3.5" aria-hidden="true" />
                          )}
                          <span>{editingMessage ? 'Lưu' : 'Gửi'}</span>
                        </Button>
                      </form>
                    )}
                  </footer>
                )}
              </div>

              <ChatInfoDrawer
                open={infoDrawerOpen}
                currentUserPublicId={currentUserPublicId}
                currentUserKeyFingerprints={
                  ownKeyBundle?.devices.map((d) => d.keyFingerprint) ?? []
                }
                peer={selectedConversation.peer}
                peerKeyFingerprints={peerKeyBundle?.devices.map((d) => d.keyFingerprint) ?? []}
                onClose={() => setInfoDrawerOpen(false)}
                onRequestDeleteConversation={() => {
                  setDialogError(null);
                  setConfirmDeleteConvTarget(selectedConversation);
                }}
                onRequestBlockPeer={() => setConfirmBlockOpen(true)}
              />
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
        key={pinModalOpen ? 'pin-open' : 'pin-closed'}
        open={pinModalOpen}
        currentUserPublicId={currentUserPublicId}
        existingBackup={serverKeyBackup}
        hasLocalRestoredBackup={hasLocalRestoredBackup}
        onClose={() => setPinModalOpen(false)}
        onBackupSynced={() => {
          void chatStore?.refreshOwnE2eeStatus({ forceBackupFetch: true });
          if (selectedConversation) {
            void chatStore?.openConversationThread(selectedConversation, { forceReload: true });
          }
          void chatStore?.loadConversations(activeTab, { background: true });
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
    </TooltipProvider>
  );
}
