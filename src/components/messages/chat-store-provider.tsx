'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

import {
  buildMessageDecryptCacheKey,
  canAutoMarkConversationRead,
  ChatStoreContext,
  clearChatRamMemorySingleton,
  DEFAULT_MESSAGES_PAGE_LIMIT,
  getOrInitUserChatRamCache,
  PEER_KEY_BUNDLE_CACHE_TTL_MS,
  putLruConversationThreadCache,
  putLruDecryptedMessageCache,
  shouldRenderFloatingMessagesWidget,
  type CachedConversationThreadState,
  type ChatStoreContextValue,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import { isConversationUnread } from '@/components/messages/message-grouping';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { authFetch } from '@/lib/auth-client';
import { decryptDirectMessage, encryptDirectMessage } from '@/lib/e2ee/cipher';
import {
  clearE2eeClientBootstrapState,
  ensureE2eeDeviceRegisteredSingleton,
  fetchServerKeyBackupLazySingleton,
} from '@/lib/e2ee/client-bootstrap';
import {
  getBackupDeviceKeyMaterial,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
} from '@/lib/e2ee/keystore';
import type { E2eeTargetDevicePublicKey } from '@/lib/e2ee/types';
import type {
  ChatMessageDto,
  ConversationListResult,
  ConversationSummaryDto,
  E2eeKeyBackupDto,
  MarkConversationReadResult,
  MessageListResult,
  SendMessageResult,
  UserE2eeKeyBundleDto,
} from '@/modules/chat';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';

export interface ChatStoreProviderProps {
  readonly currentUserPublicId: string;
  readonly children: React.ReactNode;
}

export function ChatStoreProvider({ currentUserPublicId, children }: ChatStoreProviderProps) {
  const pathname = usePathname();
  const realtime = useRealtimePresence();
  const activeStatusEnabled = realtime?.activeStatusEnabled ?? true;
  const readReceiptsEnabled = realtime?.readReceiptsEnabled ?? true;
  const e2eeReady = realtime?.e2eeReady ?? false;
  const subscribeChatEvents = realtime?.subscribeChatEvents;

  const [activeTab, setActiveTabState] = React.useState<'primary' | 'pending'>(
    () => getOrInitUserChatRamCache(currentUserPublicId).activeTab,
  );
  const [primaryConversations, setPrimaryConversationsState] = React.useState<
    readonly ConversationSummaryDto[]
  >(() => getOrInitUserChatRamCache(currentUserPublicId).primaryConversations);
  const [pendingConversations, setPendingConversationsState] = React.useState<
    readonly ConversationSummaryDto[]
  >(() => getOrInitUserChatRamCache(currentUserPublicId).pendingConversations);
  const [hasLoadedPrimary, setHasLoadedPrimaryState] = React.useState(
    () => getOrInitUserChatRamCache(currentUserPublicId).hasLoadedPrimary,
  );
  const [hasLoadedPending, setHasLoadedPendingState] = React.useState(
    () => getOrInitUserChatRamCache(currentUserPublicId).hasLoadedPending,
  );
  const [loadingConversations, setLoadingConversations] = React.useState(false);
  const [unreadConversationsCount, setUnreadConversationsCountState] = React.useState(
    () => getOrInitUserChatRamCache(currentUserPublicId).unreadConversationsCount,
  );
  const [pendingCount, setPendingCountState] = React.useState(
    () => getOrInitUserChatRamCache(currentUserPublicId).pendingCount,
  );
  const [selectedConversation, setSelectedConversationState] =
    React.useState<ConversationSummaryDto | null>(
      () => getOrInitUserChatRamCache(currentUserPublicId).selectedConversation,
    );
  const [previewsByConvId, setPreviewsByConvIdState] = React.useState<
    Readonly<Record<string, string>>
  >(() => getOrInitUserChatRamCache(currentUserPublicId).previewsByConvId);
  const [presences, setPresencesState] = React.useState<
    Readonly<Record<string, PresenceStatusDto | null>>
  >(() => getOrInitUserChatRamCache(currentUserPublicId).presences);
  const [ownKeyBundle, setOwnKeyBundleState] = React.useState<UserE2eeKeyBundleDto | null>(
    () => getOrInitUserChatRamCache(currentUserPublicId).ownKeyBundle,
  );
  const [serverKeyBackup, setServerKeyBackupState] = React.useState<E2eeKeyBackupDto | null>(
    () => getOrInitUserChatRamCache(currentUserPublicId).serverKeyBackup,
  );
  const [hasLocalRestoredBackup, setHasLocalRestoredBackupState] = React.useState(
    () => getOrInitUserChatRamCache(currentUserPublicId).hasLocalRestoredBackup,
  );
  const [threadVersion, setThreadVersion] = React.useState(0);

  const pathnameRef = React.useRef<string | null>(pathname);
  const isMessagesViewportActiveRef = React.useRef<boolean>(false);
  const floatingActiveConvIdRef = React.useRef<string | null>(null);
  const selectedConvRef = React.useRef<ConversationSummaryDto | null>(selectedConversation);
  const primaryConvsRef = React.useRef<readonly ConversationSummaryDto[]>(primaryConversations);
  const pendingConvsRef = React.useRef<readonly ConversationSummaryDto[]>(pendingConversations);
  const ownKeyBundleRef = React.useRef<UserE2eeKeyBundleDto | null>(ownKeyBundle);
  const inFlightPeerKeysRef = React.useRef<Map<string, Promise<UserE2eeKeyBundleDto | null>>>(
    new Map(),
  );
  const inFlightThreadLoadByConvRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const inFlightReadReqRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const inFlightOwnStatusRef = React.useRef<Promise<void> | null>(null);
  const prevReadReceiptsEnabledRef = React.useRef<boolean | undefined>(
    realtime?.readReceiptsEnabled,
  );

  React.useEffect(() => {
    pathnameRef.current = pathname;
    if (!pathname || !pathname.startsWith('/messages')) {
      isMessagesViewportActiveRef.current = false;
    }
    if (!shouldRenderFloatingMessagesWidget(pathname)) {
      floatingActiveConvIdRef.current = null;
    }
  }, [pathname]);

  React.useEffect(() => {
    selectedConvRef.current = selectedConversation;
  }, [selectedConversation]);

  React.useEffect(() => {
    primaryConvsRef.current = primaryConversations;
  }, [primaryConversations]);

  React.useEffect(() => {
    pendingConvsRef.current = pendingConversations;
  }, [pendingConversations]);

  React.useEffect(() => {
    ownKeyBundleRef.current = ownKeyBundle;
  }, [ownKeyBundle]);

  const bumpThreadVersion = React.useCallback(() => {
    setThreadVersion((v) => v + 1);
  }, []);

  const setActiveTab = React.useCallback(
    (tab: 'primary' | 'pending') => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      store.activeTab = tab;
      setActiveTabState(tab);
    },
    [currentUserPublicId],
  );

  const setPrimaryConversations = React.useCallback(
    (
      updater:
        | readonly ConversationSummaryDto[]
        | ((prev: readonly ConversationSummaryDto[]) => readonly ConversationSummaryDto[]),
    ) => {
      setPrimaryConversationsState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.primaryConversations = next;
        primaryConvsRef.current = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setPendingConversations = React.useCallback(
    (
      updater:
        | readonly ConversationSummaryDto[]
        | ((prev: readonly ConversationSummaryDto[]) => readonly ConversationSummaryDto[]),
    ) => {
      setPendingConversationsState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.pendingConversations = next;
        pendingConvsRef.current = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setUnreadConversationsCount = React.useCallback(
    (updater: number | ((prev: number) => number)) => {
      setUnreadConversationsCountState((prev) => {
        const raw = typeof updater === 'function' ? updater(prev) : updater;
        const next = Math.max(0, raw);
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.unreadConversationsCount = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setPendingCount = React.useCallback(
    (updater: number | ((prev: number) => number)) => {
      setPendingCountState((prev) => {
        const raw = typeof updater === 'function' ? updater(prev) : updater;
        const next = Math.max(0, raw);
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.pendingCount = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const selectConversation = React.useCallback(
    (conv: ConversationSummaryDto | null) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      store.selectedConversation = conv;
      selectedConvRef.current = conv;
      setSelectedConversationState(conv);
    },
    [currentUserPublicId],
  );

  const setPreviewsByConvId = React.useCallback(
    (updater: (prev: Readonly<Record<string, string>>) => Record<string, string>) => {
      setPreviewsByConvIdState((prev) => {
        const next = updater(prev);
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.previewsByConvId = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setPresences = React.useCallback(
    (
      updater:
        | Readonly<Record<string, PresenceStatusDto | null>>
        | ((
            prev: Readonly<Record<string, PresenceStatusDto | null>>,
          ) => Record<string, PresenceStatusDto | null>),
    ) => {
      setPresencesState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : { ...updater };
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        store.presences = next;
        return next;
      });
    },
    [currentUserPublicId],
  );

  const getThreadState = React.useCallback(
    (conversationPublicId: string): CachedConversationThreadState | null => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      return store.threadsByConvId.get(conversationPublicId) ?? null;
    },
    [currentUserPublicId],
  );

  const updateThreadState = React.useCallback(
    (
      conversationPublicId: string,
      updater: (prev: CachedConversationThreadState | null) => CachedConversationThreadState,
    ) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const prev = store.threadsByConvId.get(conversationPublicId) ?? null;
      const next = updater(prev);
      putLruConversationThreadCache(store.threadsByConvId, conversationPublicId, next);
      bumpThreadVersion();
    },
    [bumpThreadVersion, currentUserPublicId],
  );

  const getCachedPeerKeyBundle = React.useCallback(
    (peerPublicId: string): UserE2eeKeyBundleDto | null => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const norm = peerPublicId.trim().toLowerCase();
      const entry = store.peerKeyBundlesByUserId.get(norm);
      if (!entry) {
        return null;
      }
      if (Date.now() > entry.expiresAt) {
        store.peerKeyBundlesByUserId.delete(norm);
        return null;
      }
      return entry.bundle;
    },
    [currentUserPublicId],
  );

  const ensurePeerKeyBundle = React.useCallback(
    async (
      peerPublicId: string,
      options?: { readonly forceRefresh?: boolean },
    ): Promise<UserE2eeKeyBundleDto | null> => {
      const norm = peerPublicId.trim().toLowerCase();
      if (!options?.forceRefresh) {
        const cached = getCachedPeerKeyBundle(norm);
        if (cached) {
          return cached;
        }
      }

      const existingPromise = inFlightPeerKeysRef.current.get(norm);
      if (existingPromise) {
        return existingPromise;
      }

      const promise = (async (): Promise<UserE2eeKeyBundleDto | null> => {
        const store = getOrInitUserChatRamCache(currentUserPublicId);
        try {
          const res = await authFetch(
            `/api/v1/e2ee/users/${encodeURIComponent(peerPublicId)}/keys`,
          );
          if (!res.ok) {
            return store.peerKeyBundlesByUserId.get(norm)?.bundle ?? null;
          }
          const bundle = (await res.json()) as UserE2eeKeyBundleDto;
          store.peerKeyBundlesByUserId.set(norm, {
            bundle,
            expiresAt: Date.now() + PEER_KEY_BUNDLE_CACHE_TTL_MS,
          });
          bumpThreadVersion();
          return bundle;
        } catch {
          return store.peerKeyBundlesByUserId.get(norm)?.bundle ?? null;
        } finally {
          inFlightPeerKeysRef.current.delete(norm);
        }
      })();

      inFlightPeerKeysRef.current.set(norm, promise);
      return promise;
    },
    [bumpThreadVersion, currentUserPublicId, getCachedPeerKeyBundle],
  );

  /**
   * Giải mã 1 tin nhắn E2EE có bộ đệm memoization theo `(messagePublicId, editedAt, recalledAt)`:
   * Mỗi tin nhắn chỉ giải mã WebCrypto đúng 1 lần duy nhất trong suốt phiên làm việc.
   */
  const decryptSingleMessageCached = React.useCallback(
    async (
      dto: ChatMessageDto,
      senderDevices?: readonly E2eeTargetDevicePublicKey[],
    ): Promise<DecryptedMessageViewItem> => {
      if (dto.recalledAt) {
        return {
          dto,
          plaintext: 'Tin nhắn đã được thu hồi',
          decryptionFailed: false,
        };
      }
      if (!dto.ciphertext || !dto.cryptoHeader) {
        return {
          dto,
          plaintext: 'Tin nhắn không còn khả dụng',
          decryptionFailed: false,
        };
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const cacheKey = buildMessageDecryptCacheKey(dto);
      const cached = store.decryptedMessagesByCacheKey.get(cacheKey);
      if (cached && !cached.decryptionFailed) {
        return {
          dto,
          plaintext: cached.plaintext,
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

        putLruDecryptedMessageCache(store.decryptedMessagesByCacheKey, cacheKey, {
          plaintext: decrypted.text,
          decryptionFailed: false,
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

  /**
   * Nạp thông tin khóa công khai của bản thân và kiểm tra lười (lazy check) trạng thái bản sao lưu PIN:
   * - Sử dụng Singleton E2EE Bootstrap để không gọi trùng `POST /api/v1/e2ee/devices`.
   * - Chỉ gọi `GET /api/v1/e2ee/backup` khi `bundle.hasKeyBackup === true` và máy hiện tại chưa khôi phục khóa đó.
   */
  const refreshOwnE2eeStatus = React.useCallback(
    async (options?: { readonly forceBackupFetch?: boolean }) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      if (!options?.forceBackupFetch && store.ownKeyBundle !== null) {
        return;
      }
      if (inFlightOwnStatusRef.current && !options?.forceBackupFetch) {
        return inFlightOwnStatusRef.current;
      }

      const task = (async () => {
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);
        await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
        try {
          const [keysRes, localBackup] = await Promise.all([
            authFetch(`/api/v1/e2ee/users/${encodeURIComponent(currentUserPublicId)}/keys`),
            getBackupDeviceKeyMaterial(currentUserPublicId),
          ]);

          if (!keysRes.ok) {
            return;
          }

          const bundle = (await keysRes.json()) as UserE2eeKeyBundleDto;
          targetStore.ownKeyBundle = bundle;
          ownKeyBundleRef.current = bundle;
          setOwnKeyBundleState(bundle);

          const alreadyRestoredLocally = Boolean(
            localBackup &&
            bundle.backupKeyFingerprint &&
            localBackup.keyFingerprint.toLowerCase() === bundle.backupKeyFingerprint.toLowerCase(),
          );
          targetStore.hasLocalRestoredBackup = alreadyRestoredLocally;
          setHasLocalRestoredBackupState(alreadyRestoredLocally);

          if (!bundle.hasKeyBackup) {
            targetStore.serverKeyBackup = null;
            setServerKeyBackupState(null);
            return;
          }

          if (!alreadyRestoredLocally || options?.forceBackupFetch) {
            const backup = await fetchServerKeyBackupLazySingleton(currentUserPublicId, {
              hasKeyBackupOnServer: bundle.hasKeyBackup,
              expectedBackupFingerprint: bundle.backupKeyFingerprint,
              forceRefresh: options?.forceBackupFetch,
            });
            targetStore.serverKeyBackup = backup;
            setServerKeyBackupState(backup);
          }
        } catch {
          // Bỏ qua lỗi mạng tạm thời.
        }
      })();

      inFlightOwnStatusRef.current = task;
      try {
        await task;
      } finally {
        if (inFlightOwnStatusRef.current === task) {
          inFlightOwnStatusRef.current = null;
        }
      }
    },
    [currentUserPublicId],
  );

  const resolveConversationById = React.useCallback(
    (conversationPublicId: string): ConversationSummaryDto | null => {
      if (selectedConvRef.current?.public_id === conversationPublicId) {
        return selectedConvRef.current;
      }
      return (
        primaryConvsRef.current.find((c) => c.public_id === conversationPublicId) ??
        pendingConvsRef.current.find((c) => c.public_id === conversationPublicId) ??
        null
      );
    },
    [],
  );

  const checkCanAutoMarkRead = React.useCallback(
    (conversationPublicId: string, targetSeq: number): boolean => {
      const visibilityState = typeof document !== 'undefined' ? document.visibilityState : 'hidden';
      const windowHasFocus =
        typeof document !== 'undefined' && typeof document.hasFocus === 'function'
          ? document.hasFocus()
          : true;
      return canAutoMarkConversationRead({
        pathname: pathnameRef.current,
        isMessagesViewportActive: isMessagesViewportActiveRef.current,
        selectedConversation: selectedConvRef.current,
        floatingActiveConversationPublicId: floatingActiveConvIdRef.current,
        floatingConversation: resolveConversationById(conversationPublicId),
        targetConversationPublicId: conversationPublicId,
        targetSeq,
        documentVisibilityState: visibilityState,
        windowHasFocus,
      });
    },
    [resolveConversationById],
  );

  /**
   * Đánh dấu cuộc hội thoại là đã đọc với Optimistic UI tức thì (0ms):
   * - Gỡ ngay chấm đỏ ở danh sách bên trái + giảm ngay huy hiệu trên TopBar.
   * - Gọi API `POST /api/v1/conversations/[id]/read` ở nền (có khử trùng lặp theo `(convId, targetSeq)`).
   */
  const markConversationReadOptimistic = React.useCallback(
    async (conversationPublicId: string, explicitTargetSeq?: number) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const targetConv =
        primaryConvsRef.current.find((c) => c.public_id === conversationPublicId) ??
        (selectedConvRef.current?.public_id === conversationPublicId
          ? selectedConvRef.current
          : null);

      const targetSeq = explicitTargetSeq ?? targetConv?.lastSeq ?? 0;
      if (targetSeq <= 0) {
        return;
      }

      if (targetConv && targetConv.myState.inboxState !== 'primary') {
        return;
      }

      const currentMyReadSeq = targetConv?.myState.lastReadSeq ?? 0;
      const wasTrackedUnread = store.unreadPrimaryConvIds.has(conversationPublicId);
      const wasUnread = wasTrackedUnread || (targetConv ? isConversationUnread(targetConv) : false);

      if (targetSeq > currentMyReadSeq || wasUnread) {
        const nextReadSeq = Math.max(currentMyReadSeq, targetSeq);
        store.unreadPrimaryConvIds.delete(conversationPublicId);

        setPrimaryConversations((prev) =>
          prev.map((c) =>
            c.public_id === conversationPublicId
              ? {
                  ...c,
                  myState: {
                    ...c.myState,
                    lastReadSeq: Math.max(c.myState.lastReadSeq, nextReadSeq),
                  },
                }
              : c,
          ),
        );

        if (selectedConvRef.current?.public_id === conversationPublicId) {
          selectConversation({
            ...selectedConvRef.current,
            myState: {
              ...selectedConvRef.current.myState,
              lastReadSeq: Math.max(selectedConvRef.current.myState.lastReadSeq, nextReadSeq),
            },
          });
        }

        if (wasUnread) {
          setUnreadConversationsCount((count) =>
            Math.min(Math.max(0, count - 1), store.unreadPrimaryConvIds.size),
          );
        }
      }

      const lastSentSeq = store.lastSentReadSeqByConvId.get(conversationPublicId) ?? 0;
      if (targetSeq <= lastSentSeq) {
        return;
      }

      const existingReq = inFlightReadReqRef.current.get(conversationPublicId);
      if (existingReq) {
        return existingReq;
      }

      store.lastSentReadSeqByConvId.set(conversationPublicId, targetSeq);

      const reqPromise = (async () => {
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);
        try {
          const res = await authFetch(
            `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/read`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lastReadSeq: targetSeq }),
            },
          );
          if (!res.ok) {
            return;
          }
          const data = (await res.json()) as MarkConversationReadResult;
          targetStore.lastSentReadSeqByConvId.set(
            conversationPublicId,
            Math.max(lastSentSeq, data.lastReadSeq),
          );

          if (typeof data.unreadConversationsCount === 'number') {
            setUnreadConversationsCount(data.unreadConversationsCount);
          }

          setPrimaryConversations((prev) =>
            prev.map((c) =>
              c.public_id === conversationPublicId
                ? {
                    ...c,
                    myState: {
                      ...c.myState,
                      lastReadSeq: Math.max(c.myState.lastReadSeq, data.lastReadSeq),
                    },
                    peerLastReadSeq: data.peerLastReadSeq,
                  }
                : c,
            ),
          );

          if (selectedConvRef.current?.public_id === conversationPublicId) {
            selectConversation({
              ...selectedConvRef.current,
              myState: {
                ...selectedConvRef.current.myState,
                lastReadSeq: Math.max(
                  selectedConvRef.current.myState.lastReadSeq,
                  data.lastReadSeq,
                ),
              },
              peerLastReadSeq: data.peerLastReadSeq,
            });
          }
        } catch {
          // Giữ trạng thái Optimistic trên UI.
        } finally {
          inFlightReadReqRef.current.delete(conversationPublicId);
        }
      })();

      inFlightReadReqRef.current.set(conversationPublicId, reqPromise);
      return reqPromise;
    },
    [currentUserPublicId, selectConversation, setPrimaryConversations, setUnreadConversationsCount],
  );

  const loadConversations = React.useCallback(
    async (tabToLoad: 'primary' | 'pending', options?: { readonly background?: boolean }) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const alreadyLoaded =
        tabToLoad === 'primary' ? store.hasLoadedPrimary : store.hasLoadedPending;
      if (!options?.background && !alreadyLoaded) {
        setLoadingConversations(true);
      }

      try {
        const response = await authFetch(`/api/v1/conversations?tab=${tabToLoad}&limit=30`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as ConversationListResult;
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);

        let normalizedItems: readonly ConversationSummaryDto[] = data.items;
        if (tabToLoad === 'primary') {
          normalizedItems = data.items.map((item) => {
            const locallyReadSeq = targetStore.lastSentReadSeqByConvId.get(item.public_id) ?? 0;
            if (locallyReadSeq > item.myState.lastReadSeq) {
              return {
                ...item,
                myState: {
                  ...item.myState,
                  lastReadSeq: locallyReadSeq,
                },
              };
            }
            return item;
          });

          targetStore.hasLoadedPrimary = true;
          setHasLoadedPrimaryState(true);
          setPrimaryConversations(normalizedItems);

          targetStore.unreadPrimaryConvIds.clear();
          for (const convItem of normalizedItems) {
            if (isConversationUnread(convItem)) {
              targetStore.unreadPrimaryConvIds.add(convItem.public_id);
            }
          }
        } else {
          targetStore.hasLoadedPending = true;
          setHasLoadedPendingState(true);
          setPendingConversations(data.items);
        }

        setPendingCount(data.pendingCount);
        if (typeof data.unreadConversationsCount === 'number') {
          if (tabToLoad === 'primary' && inFlightReadReqRef.current.size > 0) {
            setUnreadConversationsCount(targetStore.unreadPrimaryConvIds.size);
          } else {
            setUnreadConversationsCount(
              Math.max(data.unreadConversationsCount, targetStore.unreadPrimaryConvIds.size),
            );
          }
        }

        // Đồng bộ lại selectedConversation nếu đang mở 1 hội thoại trong danh sách vừa tải.
        const currentSelected = selectedConvRef.current;
        if (currentSelected) {
          const updatedSelected = normalizedItems.find(
            (c) => c.public_id === currentSelected.public_id,
          );
          if (updatedSelected) {
            selectConversation(updatedSelected);
          }
        }

        const previewEntries = await Promise.all(
          data.items.map(async (conv) => {
            if (!conv.lastMessage) {
              return [conv.public_id, 'Bắt đầu cuộc trò chuyện'] as const;
            }
            const dec = await decryptSingleMessageCached(conv.lastMessage);
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

        if (tabToLoad === 'primary' && data.items.length > 0 && activeStatusEnabled) {
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
                setPresences((prev) => ({
                  ...prev,
                  ...presData.presences,
                }));
              }
            }
          }
        }
      } catch {
        // Bỏ qua lỗi mạng tạm thời; giữ nguyên dữ liệu từ RAM cache.
      } finally {
        setLoadingConversations(false);
      }
    },
    [
      activeStatusEnabled,
      currentUserPublicId,
      decryptSingleMessageCached,
      selectConversation,
      setPendingConversations,
      setPendingCount,
      setPresences,
      setPreviewsByConvId,
      setPrimaryConversations,
      setUnreadConversationsCount,
    ],
  );

  /**
   * Đồng bộ ngầm các tin nhắn mới (`?afterSeq=...`) mà KHÔNG bật trạng thái loading toàn khung chat.
   */
  const deltaSyncConversationThread = React.useCallback(
    async (conversationPublicId: string, peerPublicId?: string) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const existingThread = store.threadsByConvId.get(conversationPublicId);
      if (!existingThread || !existingThread.hasInitialized) {
        return;
      }

      const lastKnownSeq = existingThread.highestSeq;
      try {
        const [msgRes, peerBundle] = await Promise.all([
          authFetch(
            `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/messages?afterSeq=${lastKnownSeq}&limit=50`,
          ),
          peerPublicId ? ensurePeerKeyBundle(peerPublicId) : Promise.resolve(null),
        ]);

        if (!msgRes.ok) {
          return;
        }
        const data = (await msgRes.json()) as MessageListResult;
        if (data.items.length === 0) {
          return;
        }

        const decryptedNew = await Promise.all(
          data.items.map((item) => {
            const expectedDevices = item.isOwnMessage
              ? ownKeyBundleRef.current?.devices
              : peerBundle?.devices;
            return decryptSingleMessageCached(item, expectedDevices);
          }),
        );

        let nextHighestSeq = lastKnownSeq;
        for (const item of data.items) {
          if (item.seq > nextHighestSeq) {
            nextHighestSeq = item.seq;
          }
        }

        updateThreadState(conversationPublicId, (prev) => {
          const baseItems = prev?.items ?? [];
          const byClientMsgId = new Map(baseItems.map((m) => [m.dto.clientMsgId, m]));
          for (const incoming of decryptedNew) {
            byClientMsgId.set(incoming.dto.clientMsgId, incoming);
          }
          const merged = Array.from(byClientMsgId.values()).sort((a, b) => a.dto.seq - b.dto.seq);
          return {
            conversationPublicId,
            items: merged,
            nextBeforeSeq: prev?.nextBeforeSeq ?? null,
            highestSeq: Math.max(prev?.highestSeq ?? 0, nextHighestSeq),
            hasInitialized: true,
            loadingInitial: false,
            loadingOlder: prev?.loadingOlder ?? false,
            lastAccessedAt: Date.now(),
          };
        });

        const latest = decryptedNew[decryptedNew.length - 1];
        if (latest) {
          setPreviewsByConvId((prev) => ({
            ...prev,
            [conversationPublicId]: `${latest.dto.isOwnMessage ? 'Bạn: ' : ''}${latest.plaintext}`,
          }));

          // Chỉ tự động đánh dấu đã đọc khi thỏa mãn đủ 4 điều kiện (đang ở `/messages`, khung chat đang mount, đúng đoạn chat đang mở và cửa sổ đang hiển thị/focus).
          if (
            !latest.dto.isOwnMessage &&
            checkCanAutoMarkRead(conversationPublicId, nextHighestSeq)
          ) {
            void markConversationReadOptimistic(conversationPublicId, nextHighestSeq);
          }
        }
      } catch {
        // Bỏ qua lỗi mạng tạm thời.
      }
    },
    [
      checkCanAutoMarkRead,
      currentUserPublicId,
      decryptSingleMessageCached,
      ensurePeerKeyBundle,
      markConversationReadOptimistic,
      setPreviewsByConvId,
      updateThreadState,
    ],
  );

  /**
   * Mở luồng tin nhắn của một cuộc hội thoại:
   * - Nếu đã có trong RAM cache (`hasInitialized === true`): hiển thị TỨC THÌ (0ms, không hiện "Đang tải cuộc trò chuyện...")
   *   và chỉ chạy `deltaSyncConversationThread` ngầm ở hậu trường.
   * - Nếu mở lần đầu: chờ `ensureE2eeDeviceRegisteredSingleton` sẵn sàng, tải trang gần nhất `limit = 25` tin nhắn và giải mã.
   * - Khử trùng lặp bằng `inFlightThreadLoadByConvRef` và đảm bảo khối `finally` luôn tắt `loadingInitial: false`.
   */
  const openConversationThread = React.useCallback(
    async (conv: ConversationSummaryDto, options?: { readonly forceReload?: boolean }) => {
      selectConversation(conv);

      if (
        conv.myState.inboxState === 'primary' &&
        (isConversationUnread(conv) || checkCanAutoMarkRead(conv.public_id, conv.lastSeq))
      ) {
        void markConversationReadOptimistic(conv.public_id, conv.lastSeq);
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const cachedThread = store.threadsByConvId.get(conv.public_id);
      if (
        cachedThread &&
        cachedThread.hasInitialized &&
        !cachedThread.errorMessage &&
        !options?.forceReload
      ) {
        updateThreadState(conv.public_id, (prev) => ({
          ...(prev ?? cachedThread),
          loadingInitial: false,
          errorMessage: null,
          lastAccessedAt: Date.now(),
        }));
        void ensurePeerKeyBundle(conv.peer.public_id);
        void deltaSyncConversationThread(conv.public_id, conv.peer.public_id);
        return;
      }

      const existingLoad = inFlightThreadLoadByConvRef.current.get(conv.public_id);
      if (existingLoad && !options?.forceReload) {
        return existingLoad;
      }

      updateThreadState(conv.public_id, (prev) => ({
        conversationPublicId: conv.public_id,
        items: prev?.items ?? [],
        nextBeforeSeq: prev?.nextBeforeSeq ?? null,
        highestSeq: prev?.highestSeq ?? 0,
        hasInitialized: prev?.hasInitialized ?? false,
        loadingInitial: (prev?.items.length ?? 0) === 0,
        loadingOlder: false,
        errorMessage: null,
        lastAccessedAt: Date.now(),
      }));

      const loadPromise = (async () => {
        try {
          await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
          const [msgRes, currentPeerBundle] = await Promise.all([
            authFetch(
              `/api/v1/conversations/${encodeURIComponent(conv.public_id)}/messages?limit=${DEFAULT_MESSAGES_PAGE_LIMIT}`,
            ),
            ensurePeerKeyBundle(conv.peer.public_id),
            ownKeyBundleRef.current ? Promise.resolve() : refreshOwnE2eeStatus(),
          ]);

          if (!msgRes.ok) {
            updateThreadState(conv.public_id, (prev) => ({
              conversationPublicId: conv.public_id,
              items: prev?.items ?? [],
              nextBeforeSeq: prev?.nextBeforeSeq ?? null,
              highestSeq: prev?.highestSeq ?? 0,
              hasInitialized: (prev?.items.length ?? 0) > 0,
              loadingInitial: false,
              loadingOlder: false,
              errorMessage: 'Không thể tải cuộc trò chuyện lúc này. Vui lòng thử lại.',
              lastAccessedAt: Date.now(),
            }));
            return;
          }

          const msgData = (await msgRes.json()) as MessageListResult;
          const decryptedItems = await Promise.all(
            msgData.items.map((item) => {
              const expectedDevices = item.isOwnMessage
                ? ownKeyBundleRef.current?.devices
                : currentPeerBundle?.devices;
              return decryptSingleMessageCached(item, expectedDevices);
            }),
          );

          let highestSeq = conv.lastSeq;
          for (const item of msgData.items) {
            if (item.seq > highestSeq) {
              highestSeq = item.seq;
            }
          }

          updateThreadState(conv.public_id, () => ({
            conversationPublicId: conv.public_id,
            items: decryptedItems,
            nextBeforeSeq: msgData.nextCursor,
            highestSeq,
            hasInitialized: true,
            loadingInitial: false,
            loadingOlder: false,
            errorMessage: null,
            lastAccessedAt: Date.now(),
          }));

          if (conv.myState.inboxState === 'primary' && highestSeq > conv.myState.lastReadSeq) {
            void markConversationReadOptimistic(conv.public_id, highestSeq);
          }
        } catch {
          updateThreadState(conv.public_id, (prev) => ({
            conversationPublicId: conv.public_id,
            items: prev?.items ?? [],
            nextBeforeSeq: prev?.nextBeforeSeq ?? null,
            highestSeq: prev?.highestSeq ?? 0,
            hasInitialized: (prev?.items.length ?? 0) > 0,
            loadingInitial: false,
            loadingOlder: false,
            errorMessage: 'Không thể tải cuộc trò chuyện lúc này. Vui lòng thử lại.',
            lastAccessedAt: Date.now(),
          }));
        } finally {
          inFlightThreadLoadByConvRef.current.delete(conv.public_id);
          updateThreadState(conv.public_id, (prev) => {
            if (!prev || !prev.loadingInitial) {
              return (
                prev ?? {
                  conversationPublicId: conv.public_id,
                  items: [],
                  nextBeforeSeq: null,
                  highestSeq: 0,
                  hasInitialized: false,
                  loadingInitial: false,
                  loadingOlder: false,
                  errorMessage: null,
                  lastAccessedAt: Date.now(),
                }
              );
            }
            return {
              ...prev,
              loadingInitial: false,
            };
          });
        }
      })();

      inFlightThreadLoadByConvRef.current.set(conv.public_id, loadPromise);
      return loadPromise;
    },
    [
      checkCanAutoMarkRead,
      currentUserPublicId,
      decryptSingleMessageCached,
      deltaSyncConversationThread,
      ensurePeerKeyBundle,
      markConversationReadOptimistic,
      refreshOwnE2eeStatus,
      selectConversation,
      updateThreadState,
    ],
  );

  /**
   * Tải thêm từng trang tin nhắn cũ hơn (`beforeSeq`, `limit = 25`) khi người dùng cuộn lên đỉnh khung chat.
   */
  const loadOlderMessages = React.useCallback(
    async (conversationPublicId: string): Promise<boolean> => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const currentThread = store.threadsByConvId.get(conversationPublicId);
      if (
        !currentThread ||
        !currentThread.hasInitialized ||
        currentThread.loadingOlder ||
        currentThread.nextBeforeSeq === null
      ) {
        return false;
      }

      const cursorToFetch = currentThread.nextBeforeSeq;
      const peerId =
        selectedConvRef.current?.public_id === conversationPublicId
          ? selectedConvRef.current.peer.public_id
          : primaryConvsRef.current.find((c) => c.public_id === conversationPublicId)?.peer
              .public_id;

      updateThreadState(conversationPublicId, (prev) => ({
        ...(prev ?? currentThread),
        loadingOlder: true,
        lastAccessedAt: Date.now(),
      }));

      try {
        const [msgRes, peerBundle] = await Promise.all([
          authFetch(
            `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/messages?beforeSeq=${cursorToFetch}&limit=${DEFAULT_MESSAGES_PAGE_LIMIT}`,
          ),
          peerId ? ensurePeerKeyBundle(peerId) : Promise.resolve(null),
        ]);

        if (!msgRes.ok) {
          updateThreadState(conversationPublicId, (prev) => ({
            ...(prev ?? currentThread),
            loadingOlder: false,
          }));
          return false;
        }

        const msgData = (await msgRes.json()) as MessageListResult;
        const decryptedOlder = await Promise.all(
          msgData.items.map((item) => {
            const expectedDevices = item.isOwnMessage
              ? ownKeyBundleRef.current?.devices
              : peerBundle?.devices;
            return decryptSingleMessageCached(item, expectedDevices);
          }),
        );

        let addedCount = 0;
        updateThreadState(conversationPublicId, (prev) => {
          const base = prev ?? currentThread;
          const existingClientMsgIds = new Set(base.items.map((m) => m.dto.clientMsgId));
          const uniqueOlder = decryptedOlder.filter(
            (m) => !existingClientMsgIds.has(m.dto.clientMsgId),
          );
          addedCount = uniqueOlder.length;
          const merged = [...uniqueOlder, ...base.items].sort((a, b) => a.dto.seq - b.dto.seq);
          return {
            ...base,
            items: merged,
            nextBeforeSeq: msgData.nextCursor,
            loadingOlder: false,
            lastAccessedAt: Date.now(),
          };
        });

        return addedCount > 0;
      } catch {
        updateThreadState(conversationPublicId, (prev) => ({
          ...(prev ?? currentThread),
          loadingOlder: false,
        }));
        return false;
      }
    },
    [currentUserPublicId, decryptSingleMessageCached, ensurePeerKeyBundle, updateThreadState],
  );

  /**
   * Gửi tin nhắn văn bản với Optimistic UI tức thì (0ms) + hỗ trợ bấm "Thử lại" khi lỗi mạng:
   * - Hiển thị ngay bong bóng với plaintext trong RAM, không cần đợi round-trip hay giải mã lại.
   * - Khi server trả về 201: cập nhật `public_id` và `seq` ngay tại chỗ + lưu vào `decryptedMessagesByCacheKey`.
   */
  const sendOptimisticTextMessage = React.useCallback(
    async (params: {
      readonly conversation: ConversationSummaryDto;
      readonly plaintext: string;
      readonly retryClientMsgId?: string;
    }) => {
      const trimmed = params.plaintext.trim();
      if (!trimmed) {
        return;
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const convId = params.conversation.public_id;
      const peerPublicId = params.conversation.peer.public_id;
      const clientMsgId =
        params.retryClientMsgId ??
        `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const nowIso = new Date().toISOString();

      const currentThread = store.threadsByConvId.get(convId);
      const optimisticSeq =
        Math.max(currentThread?.highestSeq ?? 0, params.conversation.lastSeq) + 1;

      const optimisticItem: DecryptedMessageViewItem = {
        dto: {
          public_id: clientMsgId,
          conversationPublicId: convId,
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
        sendError: null,
      };

      updateThreadState(convId, (prev) => {
        const baseItems = prev?.items ?? [];
        const exists = baseItems.some((m) => m.dto.clientMsgId === clientMsgId);
        const nextItems = exists
          ? baseItems.map((m) => (m.dto.clientMsgId === clientMsgId ? optimisticItem : m))
          : [...baseItems, optimisticItem];

        return {
          conversationPublicId: convId,
          items: nextItems,
          nextBeforeSeq: prev?.nextBeforeSeq ?? null,
          highestSeq: Math.max(prev?.highestSeq ?? 0, optimisticSeq),
          hasInitialized: true,
          loadingInitial: false,
          loadingOlder: prev?.loadingOlder ?? false,
          lastAccessedAt: Date.now(),
        };
      });

      setPreviewsByConvId((prev) => ({
        ...prev,
        [convId]: `Bạn: ${trimmed}`,
      }));

      try {
        await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
        const [senderDevice, peerKeyBundle] = await Promise.all([
          getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
          ensurePeerKeyBundle(peerPublicId),
        ]);

        if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
          throw new Error(
            `@${params.conversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào.`,
          );
        }

        const envelope = await encryptDirectMessage({
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          plaintext: trimmed,
          senderDevice,
          recipientDevices: peerKeyBundle.devices,
          senderOtherDevices: ownKeyBundleRef.current?.devices ?? [],
          sentAt: nowIso,
        });

        const response = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(convId)}/messages`,
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
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);

        // Ghi sẵn vào cache giải mã theo `public_id` chính thức từ Server để không bao giờ phải giải mã lại tin của chính mình.
        putLruDecryptedMessageCache(
          targetStore.decryptedMessagesByCacheKey,
          buildMessageDecryptCacheKey(data.message),
          {
            plaintext: trimmed,
            decryptionFailed: false,
          },
        );

        targetStore.lastSentReadSeqByConvId.set(
          convId,
          Math.max(targetStore.lastSentReadSeqByConvId.get(convId) ?? 0, data.message.seq),
        );

        updateThreadState(convId, (prev) => {
          const baseItems = prev?.items ?? [];
          const updatedItems = baseItems
            .map((item) =>
              item.dto.clientMsgId === clientMsgId
                ? {
                    dto: data.message,
                    plaintext: trimmed,
                    decryptionFailed: false,
                    sending: false,
                    sendError: null,
                  }
                : item,
            )
            .sort((a, b) => a.dto.seq - b.dto.seq);

          return {
            conversationPublicId: convId,
            items: updatedItems,
            nextBeforeSeq: prev?.nextBeforeSeq ?? null,
            highestSeq: Math.max(prev?.highestSeq ?? 0, data.message.seq),
            hasInitialized: true,
            loadingInitial: false,
            loadingOlder: prev?.loadingOlder ?? false,
            lastAccessedAt: Date.now(),
          };
        });

        if (selectedConvRef.current?.public_id === convId) {
          selectConversation(data.conversation);
        }

        setPrimaryConversations((prev) => {
          const filtered = prev.filter((c) => c.public_id !== convId);
          return [data.conversation, ...filtered];
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Không thể gửi tin nhắn. Nhấn để thử lại.';
        updateThreadState(convId, (prev) => {
          const baseItems = prev?.items ?? [];
          return {
            conversationPublicId: convId,
            items: baseItems.map((item) =>
              item.dto.clientMsgId === clientMsgId
                ? {
                    ...item,
                    sending: false,
                    sendError: message,
                  }
                : item,
            ),
            nextBeforeSeq: prev?.nextBeforeSeq ?? null,
            highestSeq: prev?.highestSeq ?? 0,
            hasInitialized: true,
            loadingInitial: false,
            loadingOlder: prev?.loadingOlder ?? false,
            lastAccessedAt: Date.now(),
          };
        });
        throw error;
      }
    },
    [
      currentUserPublicId,
      ensurePeerKeyBundle,
      selectConversation,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
    ],
  );

  const openOrCreateDirectConversation = React.useCallback(
    async (recipientPublicId: string): Promise<ConversationSummaryDto> => {
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
      await openConversationThread(data.conversation);
      void loadConversations('primary', { background: true });
      return data.conversation;
    },
    [loadConversations, openConversationThread, setActiveTab],
  );

  const acceptSelectedPendingConversation = React.useCallback(
    async (conversationPublicId: string) => {
      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/accept`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể chấp nhận cuộc trò chuyện.');
      }

      setPendingConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      setPendingCount((c) => Math.max(0, c - 1));
      setActiveTab('primary');

      const convRes = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}`,
      );
      if (convRes.ok) {
        const convData = (await convRes.json()) as {
          readonly conversation: ConversationSummaryDto;
        };
        selectConversation(convData.conversation);
        void markConversationReadOptimistic(
          convData.conversation.public_id,
          convData.conversation.lastSeq,
        );
      }
      await loadConversations('primary', { background: true });
    },
    [
      loadConversations,
      markConversationReadOptimistic,
      selectConversation,
      setActiveTab,
      setPendingConversations,
      setPendingCount,
    ],
  );

  const declineSelectedPendingConversation = React.useCallback(
    async (conversationPublicId: string) => {
      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/decline`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new Error('Không thể xóa yêu cầu tin nhắn lúc này.');
      }
      if (selectedConvRef.current?.public_id === conversationPublicId) {
        selectConversation(null);
      }
      setPendingConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      setPendingCount((c) => Math.max(0, c - 1));
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      store.threadsByConvId.delete(conversationPublicId);
      bumpThreadVersion();
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      selectConversation,
      setPendingConversations,
      setPendingCount,
    ],
  );

  const removeBlockedPeerConversationLocally = React.useCallback(
    (conversationPublicId: string) => {
      const wasUnreadPrimary = primaryConvsRef.current.some(
        (c) => c.public_id === conversationPublicId && isConversationUnread(c),
      );
      if (wasUnreadPrimary) {
        setUnreadConversationsCount((count) => Math.max(0, count - 1));
      }
      if (selectedConvRef.current?.public_id === conversationPublicId) {
        selectConversation(null);
      }
      setPrimaryConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      setPendingConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      store.threadsByConvId.delete(conversationPublicId);
      bumpThreadVersion();
      void loadConversations('primary', { background: true });
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      loadConversations,
      selectConversation,
      setPendingConversations,
      setPrimaryConversations,
      setUnreadConversationsCount,
    ],
  );

  const clearAllChatCache = React.useCallback(() => {
    clearChatRamMemorySingleton();
    clearE2eeClientBootstrapState();
    setPrimaryConversationsState([]);
    setPendingConversationsState([]);
    setHasLoadedPrimaryState(false);
    setHasLoadedPendingState(false);
    setUnreadConversationsCountState(0);
    setPendingCountState(0);
    setSelectedConversationState(null);
    setPreviewsByConvIdState({});
    setPresencesState({});
    setOwnKeyBundleState(null);
    setServerKeyBackupState(null);
    setHasLocalRestoredBackupState(false);
  }, []);

  // Khởi tạo danh sách hội thoại `primary` + `unreadConversationsCount` đúng 1 lần khi vào Dashboard
  // để huy hiệu "Tin nhắn" trên TopBar luôn hiển thị chính xác ở mọi trang và làm nóng sẵn RAM cache.
  React.useEffect(() => {
    const store = getOrInitUserChatRamCache(currentUserPublicId);
    if (store.hasLoadedPrimary) {
      return;
    }
    const timer = setTimeout(() => {
      void loadConversations('primary', { background: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [currentUserPublicId, loadConversations]);

  // Đồng bộ tức thì khi người dùng bật/tắt công tắc "Hiển thị trạng thái đã xem" tại `/settings/privacy`.
  React.useEffect(() => {
    if (
      prevReadReceiptsEnabledRef.current === undefined ||
      prevReadReceiptsEnabledRef.current === readReceiptsEnabled
    ) {
      prevReadReceiptsEnabledRef.current = readReceiptsEnabled;
      return;
    }

    prevReadReceiptsEnabledRef.current = readReceiptsEnabled;

    const timer = setTimeout(() => {
      if (!readReceiptsEnabled) {
        // Khi tắt công tắc: ẩn ngay lập tức toàn bộ `peerLastReadSeq` trên RAM UI theo quy tắc đối xứng.
        setPrimaryConversations((prev) => prev.map((c) => ({ ...c, peerLastReadSeq: null })));
        if (selectedConvRef.current) {
          selectConversation({
            ...selectedConvRef.current,
            peerLastReadSeq: null,
          });
        }
        return;
      }

      // Khi bật lại công tắc: làm mới ngầm `peerLastReadSeq` từ Server mà không cần F5 trang.
      void loadConversations('primary', { background: true });
    }, 0);

    return () => clearTimeout(timer);
  }, [loadConversations, readReceiptsEnabled, selectConversation, setPrimaryConversations]);

  const setMessagesViewportActive = React.useCallback(
    (active: boolean) => {
      isMessagesViewportActiveRef.current = active;
      if (active) {
        const current = selectedConvRef.current;
        if (current && checkCanAutoMarkRead(current.public_id, current.lastSeq)) {
          void markConversationReadOptimistic(current.public_id, current.lastSeq);
        }
      }
    },
    [checkCanAutoMarkRead, markConversationReadOptimistic],
  );

  const setFloatingViewportConversation = React.useCallback(
    (conversationPublicId: string | null) => {
      floatingActiveConvIdRef.current = conversationPublicId;
      if (conversationPublicId) {
        const target = resolveConversationById(conversationPublicId);
        if (target && checkCanAutoMarkRead(target.public_id, target.lastSeq)) {
          void markConversationReadOptimistic(target.public_id, target.lastSeq);
        }
      }
    },
    [checkCanAutoMarkRead, markConversationReadOptimistic, resolveConversationById],
  );

  // Tự động giải mã bù các tin nhắn bị `decryptionFailed: true` nếu thread được mở trước khi E2EE Bootstrap hoàn tất.
  React.useEffect(() => {
    if (!e2eeReady) {
      return;
    }
    const store = getOrInitUserChatRamCache(currentUserPublicId);
    const convIdsToRetry: string[] = [];
    for (const [convId, thread] of store.threadsByConvId.entries()) {
      if (thread.items.some((m) => m.decryptionFailed)) {
        convIdsToRetry.push(convId);
      }
    }
    if (convIdsToRetry.length === 0) {
      return;
    }

    void (async () => {
      await refreshOwnE2eeStatus();
      for (const convId of convIdsToRetry) {
        const currentThread = store.threadsByConvId.get(convId);
        if (!currentThread) {
          continue;
        }
        const peerId =
          selectedConvRef.current?.public_id === convId
            ? selectedConvRef.current.peer.public_id
            : primaryConvsRef.current.find((c) => c.public_id === convId)?.peer.public_id;
        const peerBundle = peerId ? await ensurePeerKeyBundle(peerId) : null;
        const reDecrypted = await Promise.all(
          currentThread.items.map(async (item) => {
            if (!item.decryptionFailed) {
              return item;
            }
            const expectedDevices = item.dto.isOwnMessage
              ? ownKeyBundleRef.current?.devices
              : peerBundle?.devices;
            return decryptSingleMessageCached(item.dto, expectedDevices);
          }),
        );
        updateThreadState(convId, (prev) => ({
          ...(prev ?? currentThread),
          items: reDecrypted,
        }));
      }
    })();
  }, [
    currentUserPublicId,
    decryptSingleMessageCached,
    e2eeReady,
    ensurePeerKeyBundle,
    refreshOwnE2eeStatus,
    updateThreadState,
  ]);

  // Lắng nghe sự kiện Realtime toàn cục (`chat.message.created`, `chat.conversation.read`, `chat.conversation.updated`).
  React.useEffect(() => {
    if (!subscribeChatEvents) {
      return;
    }

    return subscribeChatEvents((event) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);

      if (event.event === 'chat.message.created') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const senderPublicId =
          typeof event.data.senderPublicId === 'string' ? event.data.senderPublicId : null;
        const incomingSeq = typeof event.data.seq === 'number' ? event.data.seq : null;
        const recipientInboxState =
          event.data.recipientInboxState === 'primary' ||
          event.data.recipientInboxState === 'pending'
            ? event.data.recipientInboxState
            : null;

        if (!convId) {
          return;
        }

        const isFromMe =
          senderPublicId !== null &&
          senderPublicId.toLowerCase() === currentUserPublicId.toLowerCase();

        // CHỈ đánh dấu là đang xem trực tiếp khi người dùng đang thực sự đứng ở `/messages`, khung chat đang mount, đúng đoạn chat đó và cửa sổ đang hiển thị/focus.
        const isActivelyViewingThisPrimaryConv =
          incomingSeq !== null ? checkCanAutoMarkRead(convId, incomingSeq) : false;

        // Chỉ tính vào huy hiệu đỏ "Tin nhắn" trên TopBar khi sự kiện thuộc hộp thư `Chính` (`recipientInboxState === 'primary'`).
        const isPrimaryInboxForRecipient =
          recipientInboxState === 'primary' ||
          (recipientInboxState === null &&
            primaryConvsRef.current.some((c) => c.public_id === convId));

        if (!isFromMe && incomingSeq !== null && isPrimaryInboxForRecipient) {
          // Cập nhật ngay `lastSeq` trong RAM cho cuộc hội thoại để trạng thái chưa đọc nhất quán trước khi background fetch trả về.
          setPrimaryConversations((prev) =>
            prev.map((c) =>
              c.public_id === convId && incomingSeq > c.lastSeq
                ? {
                    ...c,
                    lastSeq: incomingSeq,
                  }
                : c,
            ),
          );
          if (
            selectedConvRef.current?.public_id === convId &&
            incomingSeq > selectedConvRef.current.lastSeq
          ) {
            selectConversation({
              ...selectedConvRef.current,
              lastSeq: incomingSeq,
            });
          }

          if (!isActivelyViewingThisPrimaryConv) {
            const wasAlreadyTrackedUnread = store.unreadPrimaryConvIds.has(convId);
            const existingPrimary = primaryConvsRef.current.find((c) => c.public_id === convId);
            const wasAlreadyUnreadInList = existingPrimary
              ? isConversationUnread(existingPrimary)
              : false;
            store.unreadPrimaryConvIds.add(convId);
            if (!wasAlreadyTrackedUnread && !wasAlreadyUnreadInList) {
              setUnreadConversationsCount((count) =>
                Math.max(count + 1, store.unreadPrimaryConvIds.size),
              );
            }
          }
        }

        const peerId = resolveConversationById(convId)?.peer.public_id;

        if (store.threadsByConvId.has(convId) || floatingActiveConvIdRef.current === convId) {
          void deltaSyncConversationThread(convId, peerId);
        }

        void loadConversations('primary', { background: true });
        if (
          recipientInboxState === 'pending' ||
          store.hasLoadedPending ||
          store.activeTab === 'pending'
        ) {
          void loadConversations('pending', { background: true });
        }
        return;
      }

      if (event.event === 'chat.conversation.read') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const readerPublicId =
          typeof event.data.readerPublicId === 'string' ? event.data.readerPublicId : null;
        const readSeq = typeof event.data.lastReadSeq === 'number' ? event.data.lastReadSeq : null;
        const serverUnreadCount =
          typeof event.data.unreadConversationsCount === 'number'
            ? event.data.unreadConversationsCount
            : null;

        if (!convId || !readerPublicId || readSeq === null) {
          return;
        }

        const isSelfRead = readerPublicId.toLowerCase() === currentUserPublicId.toLowerCase();

        if (isSelfRead) {
          store.unreadPrimaryConvIds.delete(convId);
          if (serverUnreadCount !== null) {
            setUnreadConversationsCount(serverUnreadCount);
          } else {
            setUnreadConversationsCount(store.unreadPrimaryConvIds.size);
          }
          setPrimaryConversations((prev) =>
            prev.map((c) =>
              c.public_id === convId
                ? {
                    ...c,
                    myState: {
                      ...c.myState,
                      lastReadSeq: Math.max(c.myState.lastReadSeq, readSeq),
                    },
                  }
                : c,
            ),
          );
          if (selectedConvRef.current?.public_id === convId) {
            selectConversation({
              ...selectedConvRef.current,
              myState: {
                ...selectedConvRef.current.myState,
                lastReadSeq: Math.max(selectedConvRef.current.myState.lastReadSeq, readSeq),
              },
            });
          }
          return;
        }

        // Đối phương vừa đọc tin nhắn của mình -> cập nhật ngay `peerLastReadSeq` và bumpThreadVersion để hiện nhãn "Đã xem" realtime.
        if (readReceiptsEnabled) {
          setPrimaryConversations((prev) =>
            prev.map((c) =>
              c.public_id === convId
                ? {
                    ...c,
                    peerLastReadSeq: Math.max(c.peerLastReadSeq ?? 0, readSeq),
                  }
                : c,
            ),
          );
          if (selectedConvRef.current?.public_id === convId) {
            selectConversation({
              ...selectedConvRef.current,
              peerLastReadSeq: Math.max(selectedConvRef.current.peerLastReadSeq ?? 0, readSeq),
            });
          }
          bumpThreadVersion();
        }
        return;
      }

      if (event.event === 'chat.conversation.updated') {
        void loadConversations('primary', { background: true });
        if (store.hasLoadedPending || store.activeTab === 'pending') {
          void loadConversations('pending', { background: true });
        }
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
                selectConversation(body.conversation);
              }
            },
          );
        }
      }
    });
  }, [
    bumpThreadVersion,
    checkCanAutoMarkRead,
    currentUserPublicId,
    deltaSyncConversationThread,
    loadConversations,
    readReceiptsEnabled,
    resolveConversationById,
    selectConversation,
    setPrimaryConversations,
    setUnreadConversationsCount,
    subscribeChatEvents,
  ]);

  // Tự động đánh dấu đã đọc khi người dùng quay lại tab trình duyệt hoặc focus cửa sổ lúc đang mở sẵn 1 đoạn chat chưa đọc tại `/messages` hoặc trong Cửa sổ Tin nhắn nổi.
  React.useEffect(() => {
    const handleVisibilityOrFocus = () => {
      const candidateIds = new Set<string>();
      if (selectedConvRef.current?.public_id) {
        candidateIds.add(selectedConvRef.current.public_id);
      }
      if (floatingActiveConvIdRef.current) {
        candidateIds.add(floatingActiveConvIdRef.current);
      }
      for (const convId of candidateIds) {
        const conv = resolveConversationById(convId);
        if (conv && checkCanAutoMarkRead(conv.public_id, conv.lastSeq)) {
          void markConversationReadOptimistic(conv.public_id, conv.lastSeq);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, [checkCanAutoMarkRead, markConversationReadOptimistic, resolveConversationById]);

  const contextValue = React.useMemo<ChatStoreContextValue>(
    () => ({
      activeTab,
      primaryConversations,
      pendingConversations,
      hasLoadedPrimary,
      hasLoadedPending,
      loadingConversations,
      unreadConversationsCount,
      pendingCount,
      selectedConversation,
      previewsByConvId,
      presences,
      ownKeyBundle,
      serverKeyBackup,
      hasLocalRestoredBackup,
      threadVersion,
      setActiveTab,
      selectConversation,
      setMessagesViewportActive,
      setFloatingViewportConversation,
      getThreadState,
      getCachedPeerKeyBundle,
      ensurePeerKeyBundle,
      loadConversations,
      openConversationThread,
      loadOlderMessages,
      markConversationReadOptimistic,
      sendOptimisticTextMessage,
      openOrCreateDirectConversation,
      acceptSelectedPendingConversation,
      declineSelectedPendingConversation,
      removeBlockedPeerConversationLocally,
      refreshOwnE2eeStatus,
      clearAllChatCache,
    }),
    [
      acceptSelectedPendingConversation,
      activeTab,
      clearAllChatCache,
      declineSelectedPendingConversation,
      ensurePeerKeyBundle,
      getCachedPeerKeyBundle,
      getThreadState,
      hasLoadedPending,
      hasLoadedPrimary,
      hasLocalRestoredBackup,
      loadConversations,
      loadOlderMessages,
      loadingConversations,
      markConversationReadOptimistic,
      openConversationThread,
      openOrCreateDirectConversation,
      ownKeyBundle,
      pendingConversations,
      pendingCount,
      presences,
      previewsByConvId,
      primaryConversations,
      refreshOwnE2eeStatus,
      removeBlockedPeerConversationLocally,
      selectConversation,
      selectedConversation,
      sendOptimisticTextMessage,
      serverKeyBackup,
      setActiveTab,
      setFloatingViewportConversation,
      setMessagesViewportActive,
      threadVersion,
      unreadConversationsCount,
    ],
  );

  return <ChatStoreContext.Provider value={contextValue}>{children}</ChatStoreContext.Provider>;
}
