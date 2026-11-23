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
  Send,
  Trash2,
} from 'lucide-react';

import { ChatInfoDrawer } from '@/components/messages/chat-info-drawer';
import { EmojiPickerPopover } from '@/components/messages/emoji-picker-popover';
import { NewMessageModal } from '@/components/messages/new-message-modal';
import { PinBackupModal } from '@/components/messages/pin-backup-modal';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { ConfirmDialog } from '@/components/social/confirm-dialog';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import { decryptDirectMessage, encryptDirectMessage } from '@/lib/e2ee/cipher';
import {
  getBackupDeviceKeyMaterial,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
} from '@/lib/e2ee/keystore';
import type { E2eeTargetDevicePublicKey } from '@/lib/e2ee/types';
import { cn } from '@/lib/utils';
import type {
  ChatMessageDto,
  ConversationListResult,
  ConversationSummaryDto,
  E2eeKeyBackupDto,
  MessageListResult,
  SendMessageResult,
  UserE2eeKeyBundleDto,
} from '@/modules/chat';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';

export interface MessagesViewProps {
  readonly currentUserPublicId: string;
  readonly currentUserHandle: string;
  readonly currentUserFullName: string;
}

interface DecryptedMessageViewItem {
  readonly dto: ChatMessageDto;
  readonly plaintext: string;
  readonly decryptionFailed: boolean;
  readonly sending?: boolean;
}

function formatShortTimeVi(isoTimestamp: string | null): string {
  if (!isoTimestamp) {
    return '';
  }
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
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
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

export function MessagesView({ currentUserPublicId, currentUserHandle }: MessagesViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const realtime = useRealtimePresence();

  const initialTabParam = searchParams.get('tab') === 'pending' ? 'pending' : 'primary';
  const targetToPublicIdParam = searchParams.get('to');
  const targetConversationParam = searchParams.get('conversation');

  const [activeTab, setActiveTab] = React.useState<'primary' | 'pending'>(initialTabParam);
  const [conversations, setConversations] = React.useState<readonly ConversationSummaryDto[]>([]);
  const [pendingCount, setPendingCount] = React.useState(0);
  const [loadingConversations, setLoadingConversations] = React.useState(true);
  const [selectedConversation, setSelectedConversation] =
    React.useState<ConversationSummaryDto | null>(null);

  const [messages, setMessages] = React.useState<readonly DecryptedMessageViewItem[]>([]);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [draftText, setDraftText] = React.useState('');
  const [sendingMessage, setSendingMessage] = React.useState(false);
  const [chatError, setChatError] = React.useState<string | null>(null);

  const [presences, setPresences] = React.useState<
    Readonly<Record<string, PresenceStatusDto | null>>
  >({});
  const [previewsByConvId, setPreviewsByConvId] = React.useState<Readonly<Record<string, string>>>(
    {},
  );

  const [ownKeyBundle, setOwnKeyBundle] = React.useState<UserE2eeKeyBundleDto | null>(null);
  const [peerKeyBundle, setPeerKeyBundle] = React.useState<UserE2eeKeyBundleDto | null>(null);
  const [loadingPeerKeys, setLoadingPeerKeys] = React.useState(false);

  const [serverKeyBackup, setServerKeyBackup] = React.useState<E2eeKeyBackupDto | null>(null);
  const [hasLocalRestoredBackup, setHasLocalRestoredBackup] = React.useState(false);

  const [infoDrawerOpen, setInfoDrawerOpen] = React.useState(false);
  const [newMessageModalOpen, setNewMessageModalOpen] = React.useState(false);
  const [pinModalOpen, setPinModalOpen] = React.useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState(false);

  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
  const selectedConvRef = React.useRef<ConversationSummaryDto | null>(selectedConversation);
  const maxSeqByConvRef = React.useRef<Map<string, number>>(new Map());
  const handledToParamRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    selectedConvRef.current = selectedConversation;
  }, [selectedConversation]);

  const scrollToBottom = React.useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  // Giải mã 1 tin nhắn dựa trên khóa thiết bị hiện tại trong IndexedDB + xác minh chữ ký ECDSA của người gửi.
  const decryptSingleMessage = React.useCallback(
    async (
      dto: ChatMessageDto,
      senderDevices?: readonly E2eeTargetDevicePublicKey[],
    ): Promise<DecryptedMessageViewItem> => {
      if (!dto.ciphertext || !dto.cryptoHeader) {
        return {
          dto,
          plaintext: 'Tin nhắn không còn khả dụng',
          decryptionFailed: false,
        };
      }
      try {
        await getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId);
        const localMaterials = await listLocalDeviceKeyMaterials(currentUserPublicId);
        const decrypted = await decryptDirectMessage({
          conversationPublicId: dto.conversationPublicId,
          senderPublicId: dto.senderPublicId,
          clientMsgId: dto.clientMsgId,
          ciphertext: dto.ciphertext,
          cryptoHeader: dto.cryptoHeader,
          receiverKeyMaterials: localMaterials,
          expectedSenderDevices: senderDevices,
        });
        return {
          dto,
          plaintext: decrypted.text,
          decryptionFailed: false,
        };
      } catch {
        return {
          dto,
          plaintext: 'Đồng bộ mã PIN để xem tin nhắn từ thiết bị trước',
          decryptionFailed: true,
        };
      }
    },
    [currentUserPublicId],
  );

  // Nạp thông tin khóa công khai của bản thân và trạng thái bản sao lưu PIN.
  const refreshOwnE2eeStatus = React.useCallback(async () => {
    await realtime?.ensureE2eeDeviceRegistered();
    try {
      const [keysRes, backupRes, localBackup] = await Promise.all([
        authFetch(`/api/v1/e2ee/users/${encodeURIComponent(currentUserPublicId)}/keys`),
        authFetch('/api/v1/e2ee/backup'),
        getBackupDeviceKeyMaterial(currentUserPublicId),
      ]);

      if (keysRes.ok) {
        const bundle = (await keysRes.json()) as UserE2eeKeyBundleDto;
        setOwnKeyBundle(bundle);
      }
      if (backupRes.ok) {
        const backupData = (await backupRes.json()) as { readonly backup: E2eeKeyBackupDto | null };
        setServerKeyBackup(backupData.backup);
        setHasLocalRestoredBackup(
          Boolean(
            localBackup &&
            backupData.backup &&
            localBackup.keyFingerprint === backupData.backup.keyFingerprint,
          ),
        );
      }
    } catch {
      // Bỏ qua lỗi mạng tạm thời.
    }
  }, [currentUserPublicId, realtime]);

  // Nạp danh sách hội thoại theo tab (`primary` | `pending`).
  const loadConversations = React.useCallback(
    async (tabToLoad: 'primary' | 'pending') => {
      try {
        const response = await authFetch(`/api/v1/conversations?tab=${tabToLoad}&limit=30`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as ConversationListResult;
        setConversations(data.items);
        setPendingCount(data.pendingCount);

        if (targetConversationParam && !selectedConvRef.current) {
          const found = data.items.find((c) => c.public_id === targetConversationParam);
          if (found) {
            setSelectedConversation(found);
          }
        }

        // Giải mã dòng xem trước cho từng hội thoại.
        const previewEntries = await Promise.all(
          data.items.map(async (conv) => {
            if (!conv.lastMessage) {
              return [conv.public_id, 'Bắt đầu cuộc trò chuyện'] as const;
            }
            const dec = await decryptSingleMessage(conv.lastMessage);
            return [
              conv.public_id,
              dec.decryptionFailed
                ? 'Tin nhắn riêng tư'
                : `${conv.lastMessage.isOwnMessage ? 'Bạn: ' : ''}${dec.plaintext}`,
            ] as const;
          }),
        );
        setPreviewsByConvId((prev) => {
          const next = { ...prev };
          for (const [cid, text] of previewEntries) {
            next[cid] = text;
          }
          return next;
        });

        // Chỉ truy vấn trạng thái hoạt động cho các hội thoại thuộc Hộp thư chính (`primary`).
        if (
          tabToLoad === 'primary' &&
          data.items.length > 0 &&
          (realtime?.activeStatusEnabled ?? true)
        ) {
          const peerIds = data.items
            .filter(
              (item) => !item.isAwaitingPeerAcceptance && item.myState.inboxState === 'primary',
            )
            .map((item) => item.peer.public_id);

          if (peerIds.length > 0) {
            const presRes = await authFetch('/api/v1/presence/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userPublicIds: peerIds }),
            });
            if (presRes.ok) {
              const presData = (await presRes.json()) as {
                readonly presences?: Record<string, PresenceStatusDto | null>;
              };
              if (presData.presences) {
                setPresences(presData.presences);
              }
            }
          }
        }
      } finally {
        setLoadingConversations(false);
      }
    },
    [decryptSingleMessage, realtime?.activeStatusEnabled, targetConversationParam],
  );

  // Mở hoặc khởi tạo hội thoại trực tiếp với 1 userPublicId.
  const openOrCreateDirectConversation = React.useCallback(
    async (recipientPublicId: string) => {
      setChatError(null);
      const response = await authFetch('/api/v1/conversations/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPublicId }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(body?.error?.message ?? 'Không thể mở cuộc trò chuyện với tài khoản này.');
      }

      const data = (await response.json()) as { readonly conversation: ConversationSummaryDto };
      setActiveTab('primary');
      setSelectedConversation(data.conversation);
      void loadConversations('primary');
    },
    [loadConversations],
  );

  // Tải lịch sử tin nhắn và khóa công khai của đối phương khi chọn 1 cuộc hội thoại.
  const loadSelectedConversationThread = React.useCallback(
    async (conv: ConversationSummaryDto) => {
      setLoadingMessages(true);
      setLoadingPeerKeys(true);
      setChatError(null);

      try {
        const [msgRes, peerKeysRes] = await Promise.all([
          authFetch(
            `/api/v1/conversations/${encodeURIComponent(conv.public_id)}/messages?limit=40`,
          ),
          authFetch(`/api/v1/e2ee/users/${encodeURIComponent(conv.peer.public_id)}/keys`),
        ]);

        let currentPeerBundle: UserE2eeKeyBundleDto | null = null;
        if (peerKeysRes.ok) {
          currentPeerBundle = (await peerKeysRes.json()) as UserE2eeKeyBundleDto;
          setPeerKeyBundle(currentPeerBundle);
        } else {
          setPeerKeyBundle(null);
        }
        setLoadingPeerKeys(false);

        if (!msgRes.ok) {
          setMessages([]);
          return;
        }

        const msgData = (await msgRes.json()) as MessageListResult;
        const decryptedItems = await Promise.all(
          msgData.items.map((item) => {
            const expectedDevices = item.isOwnMessage
              ? ownKeyBundle?.devices
              : currentPeerBundle?.devices;
            return decryptSingleMessage(item, expectedDevices);
          }),
        );

        let highestSeq = 0;
        for (const item of msgData.items) {
          if (item.seq > highestSeq) {
            highestSeq = item.seq;
          }
        }
        maxSeqByConvRef.current.set(conv.public_id, highestSeq);
        setMessages(decryptedItems);
        setTimeout(() => scrollToBottom(), 40);
      } finally {
        setLoadingMessages(false);
        setLoadingPeerKeys(false);
      }
    },
    [decryptSingleMessage, ownKeyBundle?.devices, scrollToBottom],
  );

  // Delta-sync khi nhận sự kiện Realtime `chat.message.created` (chỉ chứa metadata, tải bản mã qua ?afterSeq=...).
  const deltaSyncConversationMessages = React.useCallback(
    async (conversationPublicId: string) => {
      const currentConv = selectedConvRef.current;
      if (!currentConv || currentConv.public_id !== conversationPublicId) {
        void loadConversations(activeTab);
        return;
      }

      const lastKnownSeq = maxSeqByConvRef.current.get(conversationPublicId) ?? 0;
      try {
        const res = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/messages?afterSeq=${lastKnownSeq}&limit=50`,
        );
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as MessageListResult;
        if (data.items.length === 0) {
          return;
        }

        const decryptedNew = await Promise.all(
          data.items.map((item) => {
            const expectedDevices = item.isOwnMessage
              ? ownKeyBundle?.devices
              : peerKeyBundle?.devices;
            return decryptSingleMessage(item, expectedDevices);
          }),
        );

        let highestSeq = lastKnownSeq;
        for (const item of data.items) {
          if (item.seq > highestSeq) {
            highestSeq = item.seq;
          }
        }
        maxSeqByConvRef.current.set(conversationPublicId, highestSeq);

        setMessages((prev) => {
          const byClientMsgId = new Map(prev.map((m) => [m.dto.clientMsgId, m]));
          for (const incoming of decryptedNew) {
            byClientMsgId.set(incoming.dto.clientMsgId, incoming);
          }
          return Array.from(byClientMsgId.values()).sort((a, b) => a.dto.seq - b.dto.seq);
        });

        const latest = decryptedNew[decryptedNew.length - 1];
        if (latest) {
          setPreviewsByConvId((prev) => ({
            ...prev,
            [conversationPublicId]: `${latest.dto.isOwnMessage ? 'Bạn: ' : ''}${latest.plaintext}`,
          }));
        }
        setTimeout(() => scrollToBottom(), 40);
        void loadConversations(activeTab);
      } catch {
        // Bỏ qua lỗi mạng tạm thời.
      }
    },
    [
      activeTab,
      decryptSingleMessage,
      loadConversations,
      ownKeyBundle?.devices,
      peerKeyBundle?.devices,
      scrollToBottom,
    ],
  );

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void refreshOwnE2eeStatus();
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshOwnE2eeStatus]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void loadConversations(activeTab);
    }, 0);
    return () => clearTimeout(timer);
  }, [activeTab, loadConversations]);

  // Xử lý query `?to=<userPublicId>` từ nút "Nhắn tin" trên trang cá nhân `/u/[handle]`.
  React.useEffect(() => {
    if (
      !targetToPublicIdParam ||
      handledToParamRef.current === targetToPublicIdParam ||
      targetToPublicIdParam.toLowerCase() === currentUserPublicId.toLowerCase()
    ) {
      return;
    }
    handledToParamRef.current = targetToPublicIdParam;
    const timer = setTimeout(() => {
      void openOrCreateDirectConversation(targetToPublicIdParam).catch((err) => {
        setChatError(err instanceof Error ? err.message : 'Không thể mở cuộc trò chuyện.');
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [currentUserPublicId, openOrCreateDirectConversation, targetToPublicIdParam]);

  React.useEffect(() => {
    if (!selectedConversation) {
      return;
    }
    const timer = setTimeout(() => {
      void loadSelectedConversationThread(selectedConversation);
    }, 0);
    return () => clearTimeout(timer);
  }, [loadSelectedConversationThread, selectedConversation]);

  // Lắng nghe sự kiện Realtime từ RealtimePresenceProvider.
  React.useEffect(() => {
    if (!realtime?.subscribeChatEvents) {
      return;
    }
    return realtime.subscribeChatEvents((event) => {
      if (event.event === 'chat.message.created') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        if (convId) {
          void deltaSyncConversationMessages(convId);
        }
        return;
      }

      if (event.event === 'chat.conversation.updated') {
        void loadConversations(activeTab);
        const current = selectedConvRef.current;
        if (
          current &&
          typeof event.data.conversationPublicId === 'string' &&
          event.data.conversationPublicId === current.public_id
        ) {
          void authFetch(`/api/v1/conversations/${encodeURIComponent(current.public_id)}`).then(
            async (res) => {
              if (res.ok) {
                const body = (await res.json()) as {
                  readonly conversation: ConversationSummaryDto;
                };
                setSelectedConversation(body.conversation);
              }
            },
          );
        }
      }
    });
  }, [activeTab, deltaSyncConversationMessages, loadConversations, realtime]);

  async function handleSendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!selectedConversation || sendingMessage) {
      return;
    }

    const trimmed = draftText.trim();
    if (!trimmed) {
      return;
    }

    if (!selectedConversation.canSendMoreMessages) {
      setChatError(
        'Bạn chỉ có thể gửi tối đa 3 tin nhắn trước khi người nhận chấp nhận cuộc trò chuyện.',
      );
      return;
    }

    // Chặn gửi nếu người nhận chưa có khóa thiết bị nào được đăng ký.
    if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
      setChatError(
        `@${selectedConversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào. Bạn có thể nhắn tin khi họ trực tuyến.`,
      );
      return;
    }

    setSendingMessage(true);
    setChatError(null);
    const clientMsgId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();
    const optimisticSeq = (maxSeqByConvRef.current.get(selectedConversation.public_id) ?? 0) + 1;

    const optimisticItem: DecryptedMessageViewItem = {
      dto: {
        public_id: clientMsgId,
        conversationPublicId: selectedConversation.public_id,
        senderPublicId: currentUserPublicId,
        isOwnMessage: true,
        seq: optimisticSeq,
        clientMsgId,
        messageType: 'text',
        ciphertext: null,
        cryptoHeader: null,
        editCount: 0,
        editedAt: null,
        recalledAt: null,
        createdAt: nowIso,
      },
      plaintext: trimmed,
      decryptionFailed: false,
      sending: true,
    };

    setDraftText('');
    setMessages((prev) => [...prev, optimisticItem]);
    setTimeout(() => scrollToBottom(), 20);

    try {
      await realtime?.ensureE2eeDeviceRegistered();
      const senderDevice = await getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId);

      const envelope = await encryptDirectMessage({
        conversationPublicId: selectedConversation.public_id,
        senderPublicId: currentUserPublicId,
        clientMsgId,
        plaintext: trimmed,
        senderDevice,
        recipientDevices: peerKeyBundle.devices,
        senderOtherDevices: ownKeyBundle?.devices ?? [],
        sentAt: nowIso,
      });

      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(selectedConversation.public_id)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientMsgId,
            messageType: 'text',
            ciphertext: envelope.ciphertext,
            cryptoHeader: envelope.cryptoHeader,
          }),
        },
      );

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể gửi tin nhắn lúc này.');
      }

      const data = (await response.json()) as SendMessageResult;
      maxSeqByConvRef.current.set(
        selectedConversation.public_id,
        Math.max(
          maxSeqByConvRef.current.get(selectedConversation.public_id) ?? 0,
          data.message.seq,
        ),
      );

      setMessages((prev) =>
        prev.map((item) =>
          item.dto.clientMsgId === clientMsgId
            ? {
                dto: data.message,
                plaintext: trimmed,
                decryptionFailed: false,
                sending: false,
              }
            : item,
        ),
      );
      setSelectedConversation(data.conversation);
      setPreviewsByConvId((prev) => ({
        ...prev,
        [selectedConversation.public_id]: `Bạn: ${trimmed}`,
      }));
      void loadConversations(activeTab);
    } catch (error) {
      setMessages((prev) => prev.filter((item) => item.dto.clientMsgId !== clientMsgId));
      setDraftText(trimmed);
      setChatError(error instanceof Error ? error.message : 'Không thể gửi tin nhắn lúc này.');
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleAcceptRequest() {
    if (!selectedConversation || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(selectedConversation.public_id)}/accept`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể chấp nhận cuộc trò chuyện.');
      }

      setActiveTab('primary');
      const convRes = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(selectedConversation.public_id)}`,
      );
      if (convRes.ok) {
        const convData = (await convRes.json()) as {
          readonly conversation: ConversationSummaryDto;
        };
        setSelectedConversation(convData.conversation);
      }
      await loadConversations('primary');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể thực hiện thao tác.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeclineRequest() {
    if (!selectedConversation || actionBusy) {
      return;
    }
    setActionBusy(true);
    setChatError(null);
    try {
      const targetId = selectedConversation.public_id;
      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(targetId)}/decline`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new Error('Không thể xóa yêu cầu tin nhắn lúc này.');
      }
      setSelectedConversation(null);
      setConversations((prev) => prev.filter((c) => c.public_id !== targetId));
      setPendingCount((c) => Math.max(0, c - 1));
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Không thể xóa cuộc trò chuyện.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmBlockPeer() {
    if (!selectedConversation || actionBusy) {
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
        setSelectedConversation(null);
        setConversations((prev) => prev.filter((c) => c.public_id !== targetConvId));
        void loadConversations(activeTab);
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
  const recipientHasZeroKeys =
    !loadingPeerKeys && peerKeyBundle !== null && peerKeyBundle.devices.length === 0;

  return (
    <>
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
              onClick={() => setActiveTab('primary')}
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
              onClick={() => setActiveTab('pending')}
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
                        onClick={() => setSelectedConversation(conv)}
                        className={cn(
                          'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                          isSelected ? 'bg-muted/80' : null,
                        )}
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
                            <p className="truncate text-sm font-semibold text-foreground">
                              {conv.peer.fullName}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {formatShortTimeVi(conv.lastMessageAt ?? conv.createdAt)}
                            </span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{previewText}</p>
                        </div>
                      </button>
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
                      onClick={() => setSelectedConversation(null)}
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

                {/* Lịch sử tin nhắn */}
                <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
                  <div className="mx-auto max-w-sm text-center">
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

                  {loadingMessages ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                      <span>Đang tải cuộc trò chuyện...</span>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {messages.map((item) => {
                        const isMine = item.dto.isOwnMessage;
                        return (
                          <div
                            key={item.dto.clientMsgId}
                            className={cn('flex flex-col', isMine ? 'items-end' : 'items-start')}
                          >
                            <div
                              className={cn(
                                'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap shadow-2xs',
                                isMine
                                  ? 'rounded-br-xs bg-primary text-primary-foreground'
                                  : 'rounded-bl-xs border bg-muted/60 text-foreground',
                                item.decryptionFailed ? 'italic opacity-80' : null,
                              )}
                            >
                              {item.plaintext}
                            </div>
                            <span className="mt-1 px-1 text-[10px] text-muted-foreground">
                              {item.sending ? 'Đang gửi...' : formatShortTimeVi(item.dto.createdAt)}
                            </span>
                          </div>
                        );
                      })}
                      <div ref={messagesEndRef} />
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
                          disabled={sendingMessage || !selectedConversation.canSendMoreMessages}
                          onSelectEmoji={(emoji) => setDraftText((prev) => `${prev}${emoji}`)}
                        />

                        {!selectedConversation.canSendMedia ? (
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
                          rows={1}
                          value={draftText}
                          disabled={sendingMessage || !selectedConversation.canSendMoreMessages}
                          placeholder={
                            selectedConversation.canSendMoreMessages
                              ? 'Nhắn tin...'
                              : 'Đã gửi tối đa 3 tin nhắn đang chờ chấp nhận'
                          }
                          onChange={(e) => setDraftText(e.target.value)}
                          onKeyDown={(e) => {
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
                            sendingMessage ||
                            !draftText.trim() ||
                            !selectedConversation.canSendMoreMessages
                          }
                          className="h-8 rounded-xl px-3 text-xs"
                        >
                          {sendingMessage ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <>
                              <Send className="size-3.5" aria-hidden="true" />
                              <span>Gửi</span>
                            </>
                          )}
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
        onSelectRecipient={openOrCreateDirectConversation}
      />

      <PinBackupModal
        key={pinModalOpen ? 'pin-open' : 'pin-closed'}
        open={pinModalOpen}
        currentUserPublicId={currentUserPublicId}
        existingBackup={serverKeyBackup}
        hasLocalRestoredBackup={hasLocalRestoredBackup}
        onClose={() => setPinModalOpen(false)}
        onBackupSynced={() => {
          void refreshOwnE2eeStatus();
          if (selectedConversation) {
            void loadSelectedConversationThread(selectedConversation);
          }
          void loadConversations(activeTab);
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
    </>
  );
}
