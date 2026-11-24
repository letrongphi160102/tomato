'use client';

import * as React from 'react';
import { put as putVercelBlobClient } from '@vercel/blob/client';
import { usePathname } from 'next/navigation';

import {
  buildMessageDecryptCacheKey,
  canAutoMarkConversationRead,
  ChatStoreContext,
  clearChatRamMemorySingleton,
  computeHighestVisibleMessageSeq,
  DEFAULT_MESSAGES_PAGE_LIMIT,
  getOrInitUserChatRamCache,
  PEER_KEY_BUNDLE_CACHE_TTL_MS,
  purgeDecryptedMessageCacheByPublicId,
  putLruConversationThreadCache,
  putLruDecryptedMessageCache,
  putLruMediaObjectUrlCache,
  resolvePinSyncState,
  revokeMediaObjectUrlByMessageId,
  revokeMediaObjectUrlsByConversationId,
  shouldRenderFloatingMessagesWidget,
  type CachedConversationThreadState,
  type CachedPinnedMessagesState,
  type ChatStoreContextValue,
  type DecryptedMessageViewItem,
  type DecryptedPinnedMessageViewItem,
  type ForwardMessageBatchResult,
  type ForwardRecipientOutcome,
  type JumpToMessageResult,
  type PinMessageOutcome,
  type PinSyncState,
} from '@/components/messages/chat-store-context';
import {
  formatCallEventLabel,
  getConversationPreviewText,
  IMAGE_MESSAGE_PREVIEW_LABEL,
  MAX_FORWARD_RECIPIENTS,
  MAX_JUMP_LOAD_PAGES,
  MAX_PINNED_MESSAGES,
  RECALLED_MESSAGE_PLACEHOLDER,
  VOICE_MESSAGE_PREVIEW_LABEL,
} from '@/components/messages/message-actions';
import {
  isConversationUnread,
  isConversationUnreadForBadge,
  sortPrimaryConversationsWithPins,
} from '@/components/messages/message-grouping';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { authFetch } from '@/lib/auth-client';
import {
  decryptDirectMessage,
  encryptDirectMessage,
  reEncryptEditedDirectMessage,
} from '@/lib/e2ee/cipher';
import {
  clearE2eeClientBootstrapState,
  ensureE2eeDeviceRegisteredSingleton,
  fetchServerKeyBackupLazySingleton,
  setCachedServerKeyBackupInSession,
} from '@/lib/e2ee/client-bootstrap';
import {
  getBackupDeviceKeyMaterial,
  getOrCreatePrimaryDeviceKeyMaterial,
  listLocalDeviceKeyMaterials,
} from '@/lib/e2ee/keystore';
import {
  decryptMediaBinary,
  encryptMediaBinary,
  normalizeWaveformBars,
  prepareHdImageForEncryption,
  validateVoiceBinaryInput,
} from '@/lib/e2ee/media-cipher';
import {
  E2eeCryptoError,
  type DecryptedMessageMediaPayload,
  type DecryptedMessageReplyPayload,
  type E2eeTargetDevicePublicKey,
} from '@/lib/e2ee/types';
import type {
  ChatMessageDto,
  ConversationListResult,
  ConversationPreferencesResult,
  ConversationSummaryDto,
  CreateAttachmentUploadTokenResult,
  DeleteConversationForMeResult,
  DeleteMessageForMeResult,
  E2eeKeyBackupDto,
  ForwardTargetDto,
  MarkConversationReadResult,
  MessageAttachmentDownloadGrantDto,
  MessageListResult,
  MessagePinMutationResult,
  MessageReactionDto,
  MessageReactionMutationResult,
  PinnedMessagesListResult,
  SendMessageResult,
  UserE2eeKeyBundleDto,
} from '@/modules/chat';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';

const PEER_SYNC_KEY_REFRESH_COOLDOWN_MS = 15_000;

function buildVerificationDevices(
  bundle: UserE2eeKeyBundleDto | null | undefined,
): readonly E2eeTargetDevicePublicKey[] | undefined {
  if (!bundle) {
    return undefined;
  }
  const combined: E2eeTargetDevicePublicKey[] = [...bundle.devices];
  const seen = new Set(combined.map((d) => d.keyFingerprint));
  for (const hist of bundle.historicalSigningKeys ?? []) {
    if (!seen.has(hist.keyFingerprint)) {
      seen.add(hist.keyFingerprint);
      combined.push({
        devicePublicId: hist.keyFingerprint,
        keyFingerprint: hist.keyFingerprint,
        identityPublicKeyJwk: hist.identityPublicKeyJwk,
        signingPublicKeyJwk: hist.signingPublicKeyJwk,
      });
    }
  }
  return combined.length > 0 ? combined : undefined;
}

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

  const pinSyncState: PinSyncState = resolvePinSyncState(ownKeyBundle, hasLocalRestoredBackup);

  const pathnameRef = React.useRef<string | null>(pathname);
  const isMessagesViewportActiveRef = React.useRef<boolean>(false);
  const floatingActiveConvIdRef = React.useRef<string | null>(null);
  const selectedConvRef = React.useRef<ConversationSummaryDto | null>(selectedConversation);
  const primaryConvsRef = React.useRef<readonly ConversationSummaryDto[]>(primaryConversations);
  const pendingConvsRef = React.useRef<readonly ConversationSummaryDto[]>(pendingConversations);
  const ownKeyBundleRef = React.useRef<UserE2eeKeyBundleDto | null>(ownKeyBundle);
  const pinSyncStateRef = React.useRef<PinSyncState>(pinSyncState);
  const peerSyncKeyRefreshAtRef = React.useRef<Map<string, number>>(new Map());
  const inFlightPeerKeysRef = React.useRef<Map<string, Promise<UserE2eeKeyBundleDto | null>>>(
    new Map(),
  );
  const inFlightThreadLoadByConvRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const inFlightSingleMsgSyncRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const inFlightMediaDownloadsRef = React.useRef<Map<string, Promise<string | null>>>(new Map());
  const inFlightPinsLoadRef = React.useRef<Map<string, Promise<CachedPinnedMessagesState | null>>>(
    new Map(),
  );
  const inFlightReadReqRef = React.useRef<Map<string, Promise<void>>>(new Map());
  const inFlightOwnStatusRef = React.useRef<Promise<UserE2eeKeyBundleDto | null> | null>(null);
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

  React.useEffect(() => {
    pinSyncStateRef.current = pinSyncState;
  }, [pinSyncState]);

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
   * Nạp thông tin khóa công khai của bản thân và kiểm tra lười (lazy check) trạng thái bản sao lưu PIN:
   * - Sử dụng Singleton E2EE Bootstrap để không gọi trùng `POST /api/v1/e2ee/devices`.
   * - Chỉ gọi `GET /api/v1/e2ee/backup` khi `bundle.hasKeyBackup === true` và máy hiện tại chưa khôi phục khóa đó (hoặc `forceBackupFetch`).
   */
  const refreshOwnE2eeStatus = React.useCallback(
    async (options?: {
      readonly forceBackupFetch?: boolean;
      readonly forceRefresh?: boolean;
    }): Promise<UserE2eeKeyBundleDto | null> => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const mustFetch = Boolean(options?.forceRefresh || options?.forceBackupFetch);
      if (!mustFetch && store.ownKeyBundle !== null) {
        return store.ownKeyBundle;
      }
      if (inFlightOwnStatusRef.current && !mustFetch) {
        return inFlightOwnStatusRef.current;
      }

      const task = (async (): Promise<UserE2eeKeyBundleDto | null> => {
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);
        await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
        try {
          const [keysRes, localBackup] = await Promise.all([
            authFetch(`/api/v1/e2ee/users/${encodeURIComponent(currentUserPublicId)}/keys`),
            getBackupDeviceKeyMaterial(currentUserPublicId),
          ]);

          if (!keysRes.ok) {
            return targetStore.ownKeyBundle;
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
          pinSyncStateRef.current = resolvePinSyncState(bundle, alreadyRestoredLocally);

          if (!bundle.hasKeyBackup) {
            targetStore.serverKeyBackup = null;
            setServerKeyBackupState(null);
            return bundle;
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

          return bundle;
        } catch {
          return targetStore.ownKeyBundle;
        }
      })();

      inFlightOwnStatusRef.current = task;
      try {
        return await task;
      } finally {
        if (inFlightOwnStatusRef.current === task) {
          inFlightOwnStatusRef.current = null;
        }
      }
    },
    [currentUserPublicId],
  );

  /**
   * Làm mới nhẹ bộ khóa của đối phương khi gửi/sửa tin nếu cache hiện chưa thấy Khóa Đồng bộ (`isSyncKey === true`),
   * nhằm tránh bỏ sót Khóa Đồng bộ mà đối phương vừa thiết lập (có cooldown 15s/đối phương để không spam API).
   */
  const ensureFreshPeerKeyBundleForEncryption = React.useCallback(
    async (peerPublicId: string): Promise<UserE2eeKeyBundleDto | null> => {
      const initial = await ensurePeerKeyBundle(peerPublicId);
      if (initial && initial.devices.some((d) => d.isSyncKey)) {
        return initial;
      }
      const norm = peerPublicId.trim().toLowerCase();
      const lastRefreshAt = peerSyncKeyRefreshAtRef.current.get(norm) ?? 0;
      const nowMs = Date.now();
      if (nowMs - lastRefreshAt < PEER_SYNC_KEY_REFRESH_COOLDOWN_MS) {
        return initial;
      }
      peerSyncKeyRefreshAtRef.current.set(norm, nowMs);
      return (await ensurePeerKeyBundle(peerPublicId, { forceRefresh: true })) ?? initial;
    },
    [ensurePeerKeyBundle],
  );

  /**
   * Tập hợp toàn bộ thiết bị khác + Khóa Đồng bộ của chính người gửi để bọc khóa (`wrappedKeys`),
   * đảm bảo 100% tin gửi/sửa đều mở được khi đồng bộ mã PIN trên thiết bị khác.
   */
  const buildOwnSenderOtherDevices = React.useCallback(
    async (ownBundle: UserE2eeKeyBundleDto | null): Promise<E2eeTargetDevicePublicKey[]> => {
      const result: E2eeTargetDevicePublicKey[] = [...(ownBundle?.devices ?? [])];
      const seen = new Set(result.map((d) => d.keyFingerprint));
      const localBackup = await getBackupDeviceKeyMaterial(currentUserPublicId);
      if (localBackup && !seen.has(localBackup.keyFingerprint)) {
        result.unshift({
          devicePublicId: localBackup.devicePublicId,
          keyFingerprint: localBackup.keyFingerprint,
          isSyncKey: true,
          identityPublicKeyJwk: localBackup.identityPublicKeyJwk,
          signingPublicKeyJwk: localBackup.signingPublicKeyJwk,
        });
      }
      return result;
    },
    [currentUserPublicId],
  );

  /**
   * Giải mã 1 tin nhắn E2EE có bộ đệm memoization theo `(messagePublicId, editedAt, recalledAt)`:
   * - Xác minh chữ ký ECDSA trên cả thiết bị đang hoạt động lẫn `historicalSigningKeys` đã đăng ký của người gửi.
   * - Thử giải mã bằng tất cả các khóa riêng hợp lệ trong IndexedDB (khóa thiết bị + khóa đồng bộ PIN + khóa bootstrap).
   * - Nếu gặp `UNTRUSTED_SIGNING_KEY` do cache khóa cũ, tự động làm mới bộ khóa người gửi 1 lần và thử lại.
   */
  const decryptSingleMessageCached = React.useCallback(
    async (
      dto: ChatMessageDto,
      senderBundleOrDevices?: UserE2eeKeyBundleDto | readonly E2eeTargetDevicePublicKey[] | null,
    ): Promise<DecryptedMessageViewItem> => {
      if (dto.recalledAt) {
        return {
          dto,
          plaintext: RECALLED_MESSAGE_PLACEHOLDER,
          decryptionFailed: false,
        };
      }
      if (dto.messageType === 'call_event') {
        return {
          dto,
          plaintext: formatCallEventLabel(dto.callEventMeta),
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
          ...(cached.media ? { media: cached.media } : {}),
          ...(cached.replyTo ? { replyTo: cached.replyTo } : {}),
          ...(cached.forwarded ? { forwarded: true } : {}),
          decryptionFailed: false,
        };
      }

      const expectedSenderDevices = Array.isArray(senderBundleOrDevices)
        ? senderBundleOrDevices
        : buildVerificationDevices(
            senderBundleOrDevices as UserE2eeKeyBundleDto | null | undefined,
          );

      const attemptDecrypt = async (
        devicesForVerify: readonly E2eeTargetDevicePublicKey[] | undefined,
      ) => {
        await getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId);
        const localMaterials = await listLocalDeviceKeyMaterials(currentUserPublicId);
        return decryptDirectMessage({
          conversationPublicId: dto.conversationPublicId,
          senderPublicId: dto.senderPublicId,
          clientMsgId: dto.clientMsgId,
          ciphertext: dto.ciphertext!,
          cryptoHeader: dto.cryptoHeader!,
          receiverKeyMaterials: localMaterials,
          expectedSenderDevices: devicesForVerify,
        });
      };

      try {
        let decrypted;
        try {
          decrypted = await attemptDecrypt(expectedSenderDevices);
        } catch (firstError) {
          if (
            firstError instanceof E2eeCryptoError &&
            firstError.code === 'UNTRUSTED_SIGNING_KEY'
          ) {
            const refreshedBundle = dto.isOwnMessage
              ? await refreshOwnE2eeStatus({ forceRefresh: true })
              : await ensurePeerKeyBundle(dto.senderPublicId, { forceRefresh: true });
            const refreshedDevices = buildVerificationDevices(refreshedBundle);
            decrypted = await attemptDecrypt(refreshedDevices);
          } else {
            throw firstError;
          }
        }

        putLruDecryptedMessageCache(store.decryptedMessagesByCacheKey, cacheKey, {
          plaintext: decrypted.text,
          ...(decrypted.media ? { media: decrypted.media } : {}),
          ...(decrypted.replyTo ? { replyTo: decrypted.replyTo } : {}),
          ...(decrypted.forwarded ? { forwarded: true } : {}),
          decryptionFailed: false,
        });

        return {
          dto,
          plaintext: decrypted.text,
          ...(decrypted.media ? { media: decrypted.media } : {}),
          ...(decrypted.replyTo ? { replyTo: decrypted.replyTo } : {}),
          ...(decrypted.forwarded ? { forwarded: true } : {}),
          decryptionFailed: false,
        };
      } catch {
        return {
          dto,
          plaintext: 'Nhập mã PIN để đồng bộ các tin nhắn trước đây',
          decryptionFailed: true,
        };
      }
    },
    [currentUserPublicId, ensurePeerKeyBundle, refreshOwnE2eeStatus],
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
      const currentClearedBeforeSeq = targetConv?.myState.clearedBeforeSeq ?? 0;
      const effectiveReadFloor = Math.max(currentMyReadSeq, currentClearedBeforeSeq);
      const wasTrackedUnread = store.unreadPrimaryConvIds.has(conversationPublicId);
      const wasUnread = wasTrackedUnread || (targetConv ? isConversationUnread(targetConv) : false);

      // Không tự gửi `/read` cho tin nhắn đã nằm dưới mốc `clearedBeforeSeq` để tránh lộ "Đã xem" giả.
      if (targetSeq <= effectiveReadFloor && !wasUnread) {
        return;
      }

      if (targetSeq > effectiveReadFloor || wasUnread) {
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
          const sortedPrimary = sortPrimaryConversationsWithPins(normalizedItems);
          setPrimaryConversations(sortedPrimary);

          targetStore.unreadPrimaryConvIds.clear();
          for (const convItem of sortedPrimary) {
            if (isConversationUnreadForBadge(convItem)) {
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

        const needsPinSyncNow = pinSyncStateRef.current === 'needs_restore';
        const previewEntries = await Promise.all(
          data.items.map(async (conv) => {
            if (!conv.lastMessage) {
              return [conv.public_id, getConversationPreviewText(null)] as const;
            }
            if (conv.lastMessage.recalledAt !== null) {
              return [conv.public_id, RECALLED_MESSAGE_PLACEHOLDER] as const;
            }
            const cachedPeer = !conv.lastMessage.isOwnMessage
              ? getCachedPeerKeyBundle(conv.peer.public_id)
              : null;
            const dec = await decryptSingleMessageCached(
              conv.lastMessage,
              conv.lastMessage.isOwnMessage ? ownKeyBundleRef.current : cachedPeer,
            );
            return [
              conv.public_id,
              getConversationPreviewText(conv.lastMessage, dec.plaintext, dec.decryptionFailed, {
                needsPinSync: needsPinSyncNow,
              }),
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
      getCachedPeerKeyBundle,
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
            const senderBundle = item.isOwnMessage ? ownKeyBundleRef.current : peerBundle;
            return decryptSingleMessageCached(item, senderBundle);
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
            [conversationPublicId]: getConversationPreviewText(
              latest.dto,
              latest.plaintext,
              latest.decryptionFailed,
              { needsPinSync: pinSyncStateRef.current === 'needs_restore' },
            ),
          }));

          // Chỉ tự động đánh dấu đã đọc đối với tin nhắn THỰC SỰ HIỂN THỊ ĐƯỢC trên màn hình
          // (bảo toàn logic "Đã xem": tuyệt đối không đánh dấu đã đọc tin đang bị ẩn chờ nhập PIN).
          const highestVisibleNewSeq = computeHighestVisibleMessageSeq(decryptedNew);
          if (
            !latest.dto.isOwnMessage &&
            highestVisibleNewSeq > 0 &&
            checkCanAutoMarkRead(conversationPublicId, highestVisibleNewSeq)
          ) {
            void markConversationReadOptimistic(conversationPublicId, highestVisibleNewSeq);
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
  const resolveSafeAutoReadSeq = React.useCallback(
    (
      conv: ConversationSummaryDto,
      threadItems?: readonly DecryptedMessageViewItem[] | null,
    ): number => {
      const needsPin = pinSyncStateRef.current === 'needs_restore';
      if (needsPin) {
        // Trình duyệt mới chưa nhập PIN: CHỈ được đánh dấu đã đọc tới tin thực sự hiển thị được trên màn hình.
        return threadItems && threadItems.length > 0
          ? computeHighestVisibleMessageSeq(threadItems)
          : 0;
      }
      if (threadItems && threadItems.some((m) => m.decryptionFailed)) {
        return computeHighestVisibleMessageSeq(threadItems);
      }
      return threadItems && threadItems.length > 0
        ? computeHighestVisibleMessageSeq(threadItems)
        : conv.lastSeq;
    },
    [],
  );

  const getPinnedState = React.useCallback(
    (conversationPublicId: string): CachedPinnedMessagesState | null => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      return store.pinnedByConvId.get(conversationPublicId) ?? null;
    },
    [currentUserPublicId],
  );

  const loadPinnedMessages = React.useCallback(
    async (
      conversationPublicId: string,
      options?: { readonly force?: boolean },
    ): Promise<CachedPinnedMessagesState | null> => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const cached = store.pinnedByConvId.get(conversationPublicId) ?? null;
      if (cached && cached.hasLoaded && !options?.force) {
        return cached;
      }

      const existing = inFlightPinsLoadRef.current.get(conversationPublicId);
      if (existing && !options?.force) {
        return existing;
      }

      const conv = resolveConversationById(conversationPublicId);
      if (conv && (conv.myState.inboxState !== 'primary' || conv.isAwaitingPeerAcceptance)) {
        const emptyState: CachedPinnedMessagesState = {
          conversationPublicId,
          items: [],
          totalPinnedCount: 0,
          hiddenPinnedCount: 0,
          maxPinnedMessages: MAX_PINNED_MESSAGES,
          loading: false,
          hasLoaded: true,
        };
        store.pinnedByConvId.set(conversationPublicId, emptyState);
        bumpThreadVersion();
        return emptyState;
      }

      store.pinnedByConvId.set(conversationPublicId, {
        conversationPublicId,
        items: cached?.items ?? [],
        totalPinnedCount: cached?.totalPinnedCount ?? 0,
        hiddenPinnedCount: cached?.hiddenPinnedCount ?? 0,
        maxPinnedMessages: MAX_PINNED_MESSAGES,
        loading: true,
        hasLoaded: cached?.hasLoaded ?? false,
      });
      bumpThreadVersion();

      const task = (async (): Promise<CachedPinnedMessagesState | null> => {
        try {
          const peerId = resolveConversationById(conversationPublicId)?.peer.public_id;
          const [res, peerBundle] = await Promise.all([
            authFetch(`/api/v1/conversations/${encodeURIComponent(conversationPublicId)}/pins`),
            peerId ? ensurePeerKeyBundle(peerId) : Promise.resolve(null),
          ]);
          if (!res.ok) {
            return store.pinnedByConvId.get(conversationPublicId) ?? null;
          }
          const data = (await res.json()) as PinnedMessagesListResult;
          const decryptedItems: DecryptedPinnedMessageViewItem[] = await Promise.all(
            data.items.map(async (entry) => {
              const senderBundle = entry.message.isOwnMessage
                ? ownKeyBundleRef.current
                : peerBundle;
              const dec = await decryptSingleMessageCached(entry.message, senderBundle);
              return {
                message: dec,
                pinnedAt: entry.pinnedAt,
                pinnedByPublicId: entry.pinnedByPublicId,
              };
            }),
          );

          const nextState: CachedPinnedMessagesState = {
            conversationPublicId,
            items: decryptedItems,
            totalPinnedCount: data.totalPinnedCount,
            hiddenPinnedCount: data.hiddenPinnedCount,
            maxPinnedMessages: data.maxPinnedMessages,
            loading: false,
            hasLoaded: true,
          };
          getOrInitUserChatRamCache(currentUserPublicId).pinnedByConvId.set(
            conversationPublicId,
            nextState,
          );
          bumpThreadVersion();
          return nextState;
        } catch {
          const fallback =
            getOrInitUserChatRamCache(currentUserPublicId).pinnedByConvId.get(conversationPublicId);
          if (fallback) {
            getOrInitUserChatRamCache(currentUserPublicId).pinnedByConvId.set(
              conversationPublicId,
              { ...fallback, loading: false },
            );
            bumpThreadVersion();
          }
          return fallback ?? null;
        } finally {
          inFlightPinsLoadRef.current.delete(conversationPublicId);
        }
      })();

      inFlightPinsLoadRef.current.set(conversationPublicId, task);
      return task;
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      decryptSingleMessageCached,
      ensurePeerKeyBundle,
      resolveConversationById,
    ],
  );

  const openConversationThread = React.useCallback(
    async (conv: ConversationSummaryDto, options?: { readonly forceReload?: boolean }) => {
      selectConversation(conv);
      if (conv.myState.inboxState === 'primary' && !conv.isAwaitingPeerAcceptance) {
        void loadPinnedMessages(conv.public_id, { force: options?.forceReload });
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const cachedThread = store.threadsByConvId.get(conv.public_id);

      // Khi chưa đồng bộ PIN (`needs_restore`), KHÔNG tự đánh dấu đã đọc theo `conv.lastSeq` thô trước khi giải mã xong.
      const preDecryptSafeSeq = resolveSafeAutoReadSeq(
        conv,
        cachedThread?.hasInitialized ? cachedThread.items : null,
      );
      if (
        conv.myState.inboxState === 'primary' &&
        preDecryptSafeSeq > 0 &&
        (isConversationUnread(conv) || checkCanAutoMarkRead(conv.public_id, preDecryptSafeSeq))
      ) {
        void markConversationReadOptimistic(conv.public_id, preDecryptSafeSeq);
      }
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
            ownKeyBundleRef.current
              ? Promise.resolve(ownKeyBundleRef.current)
              : refreshOwnE2eeStatus(),
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
              const senderBundle = item.isOwnMessage ? ownKeyBundleRef.current : currentPeerBundle;
              return decryptSingleMessageCached(item, senderBundle);
            }),
          );

          let highestSeq = conv.lastSeq;
          for (const item of msgData.items) {
            if (item.seq > highestSeq) {
              highestSeq = item.seq;
            }
          }
          const highestVisibleSeq = computeHighestVisibleMessageSeq(decryptedItems);

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

          const effectiveReadFloor = Math.max(
            conv.myState.lastReadSeq,
            conv.myState.clearedBeforeSeq ?? 0,
          );
          if (
            conv.myState.inboxState === 'primary' &&
            highestVisibleSeq > effectiveReadFloor &&
            checkCanAutoMarkRead(conv.public_id, highestVisibleSeq)
          ) {
            void markConversationReadOptimistic(conv.public_id, highestVisibleSeq);
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
      loadPinnedMessages,
      markConversationReadOptimistic,
      refreshOwnE2eeStatus,
      resolveSafeAutoReadSeq,
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
            const senderBundle = item.isOwnMessage ? ownKeyBundleRef.current : peerBundle;
            return decryptSingleMessageCached(item, senderBundle);
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
      readonly replyTo?: DecryptedMessageReplyPayload | null;
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
      const replyToPayload = params.replyTo ?? undefined;

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
          reactions: [],
          replyToMeta: replyToPayload
            ? {
                messagePublicId: replyToPayload.messagePublicId,
                senderPublicId: replyToPayload.senderPublicId,
                seq: 0,
                messageType: replyToPayload.messageType,
                recalledAt: null,
                deletedForViewer: false,
              }
            : null,
          isPinned: false,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: nowIso,
        },
        plaintext: trimmed,
        ...(replyToPayload ? { replyTo: replyToPayload } : {}),
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
        const [senderDevice, peerKeyBundle, ownBundle] = await Promise.all([
          getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
          ensureFreshPeerKeyBundleForEncryption(peerPublicId),
          ownKeyBundleRef.current
            ? Promise.resolve(ownKeyBundleRef.current)
            : refreshOwnE2eeStatus({ forceRefresh: true }),
        ]);

        if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
          throw new Error(
            `@${params.conversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào.`,
          );
        }

        const senderOtherDevices = await buildOwnSenderOtherDevices(ownBundle);

        const envelope = await encryptDirectMessage({
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          plaintext: trimmed,
          ...(replyToPayload ? { replyTo: replyToPayload } : {}),
          senderDevice,
          recipientDevices: peerKeyBundle.devices,
          senderOtherDevices,
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
              ...(replyToPayload ? { replyToMessagePublicId: replyToPayload.messagePublicId } : {}),
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
            ...(replyToPayload ? { replyTo: replyToPayload } : {}),
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
                    ...(replyToPayload ? { replyTo: replyToPayload } : {}),
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
          return sortPrimaryConversationsWithPins([data.conversation, ...filtered]);
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
      buildOwnSenderOtherDevices,
      currentUserPublicId,
      ensureFreshPeerKeyBundleForEncryption,
      refreshOwnE2eeStatus,
      selectConversation,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
    ],
  );

  const getCachedMediaObjectUrl = React.useCallback(
    (messagePublicId: string): string | null => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      return store.mediaObjectUrlsByMsgId.get(messagePublicId)?.objectUrl ?? null;
    },
    [currentUserPublicId],
  );

  /**
   * Tải bản mã đính kèm qua cổng chống BOLA, xác minh đối chiếu SHA-256 fail-closed,
   * giải mã AES-256-GCM trong RAM và trả về ObjectURL tạm (tự động xoay vòng theo LRU tối đa 60 URL).
   * Tuyệt đối KHÔNG gọi mạng đối với tin chưa mở khóa bằng mã PIN (`decryptionFailed`) hoặc đã thu hồi.
   */
  const resolveMessageMediaObjectUrl = React.useCallback(
    async (message: DecryptedMessageViewItem): Promise<string | null> => {
      const media = message.media;
      if (
        !media ||
        message.decryptionFailed ||
        message.dto.recalledAt !== null ||
        message.sending ||
        message.dto.seq <= 0
      ) {
        return null;
      }

      const msgId = message.dto.public_id;
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const cached = store.mediaObjectUrlsByMsgId.get(msgId);
      if (cached) {
        return cached.objectUrl;
      }

      const existing = inFlightMediaDownloadsRef.current.get(msgId);
      if (existing) {
        return existing;
      }

      const task = (async (): Promise<string | null> => {
        try {
          const grantRes = await authFetch(
            `/api/v1/messages/${encodeURIComponent(msgId)}/attachment`,
          );
          if (!grantRes.ok) {
            return null;
          }
          const grant = (await grantRes.json()) as MessageAttachmentDownloadGrantDto;

          // Đối chiếu chéo SHA-256 giữa metadata đã ký E2EE và bản ghi của Server (fail-closed).
          if (grant.ciphertextSha256.toLowerCase() !== media.ciphertextSha256.toLowerCase()) {
            return null;
          }

          const binaryRes = grant.downloadUrl.startsWith('/')
            ? await authFetch(grant.downloadUrl)
            : await fetch(grant.downloadUrl, { credentials: 'omit' });
          if (!binaryRes.ok) {
            return null;
          }

          const ciphertextBytes = new Uint8Array(await binaryRes.arrayBuffer());
          const plainBytes = await decryptMediaBinary({
            ciphertextBytes,
            fileKey: media.fileKey,
            fileIv: media.fileIv,
            expectedSha256: media.ciphertextSha256,
            conversationPublicId: message.dto.conversationPublicId,
            senderPublicId: message.dto.senderPublicId,
            clientMsgId: message.dto.clientMsgId,
            mediaKind: media.kind,
          });

          const decryptedBlob = new Blob([plainBytes], { type: media.mimeType });
          const objectUrl = URL.createObjectURL(decryptedBlob);

          const targetStore = getOrInitUserChatRamCache(currentUserPublicId);
          putLruMediaObjectUrlCache(targetStore.mediaObjectUrlsByMsgId, {
            messagePublicId: msgId,
            conversationPublicId: message.dto.conversationPublicId,
            objectUrl,
            mimeType: media.mimeType,
          });
          return objectUrl;
        } catch {
          return null;
        } finally {
          inFlightMediaDownloadsRef.current.delete(msgId);
        }
      })();

      inFlightMediaDownloadsRef.current.set(msgId, task);
      return task;
    },
    [currentUserPublicId],
  );

  const uploadEncryptedAttachmentBinary = React.useCallback(
    async (
      grant: CreateAttachmentUploadTokenResult,
      ciphertextBytes: Uint8Array<ArrayBuffer>,
    ): Promise<void> => {
      const payloadBlob = new Blob([ciphertextBytes], { type: 'application/octet-stream' });

      if (grant.uploadMode === 'vercel_blob') {
        if (!grant.clientToken) {
          throw new Error('Không thể khởi tạo phiên tải tệp lên lúc này.');
        }
        await putVercelBlobClient(grant.pathname, payloadBlob, {
          access: 'public',
          token: grant.clientToken,
          contentType: 'application/octet-stream',
          multipart: ciphertextBytes.byteLength > 4 * 1024 * 1024,
        });
        return;
      }

      if (!grant.uploadUrl) {
        throw new Error('Không thể khởi tạo phiên tải tệp lên lúc này.');
      }

      const uploadRes = await authFetch(grant.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payloadBlob,
      });
      if (!uploadRes.ok) {
        const errBody = (await uploadRes.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể tải tệp lên lúc này.');
      }
    },
    [],
  );

  /**
   * Gửi ảnh HD mã hóa đầu cuối với Optimistic UI tức thì:
   * - Chuẩn hóa HD (<= 2048px, sạch EXIF/GPS) + mã hóa AES-256-GCM trên trình duyệt.
   * - Xin upload-token -> tải thẳng bản mã lên Storage -> bọc khóa tệp vào phong bì E2EE (bao gồm cả Khóa Đồng bộ PIN).
   */
  const sendOptimisticImageMessage = React.useCallback(
    async (params: {
      readonly conversation: ConversationSummaryDto;
      readonly file: File | Blob;
      readonly replyTo?: DecryptedMessageReplyPayload | null;
    }) => {
      if (!params.conversation.canSendMedia) {
        throw new Error('Cuộc trò chuyện đang chờ chấp nhận nên chưa thể gửi ảnh.');
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const convId = params.conversation.public_id;
      const peerPublicId = params.conversation.peer.public_id;
      const clientMsgId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const nowIso = new Date().toISOString();
      const replyToPayload = params.replyTo ?? undefined;

      const prepared = await prepareHdImageForEncryption(params.file);
      const tempPreviewUrl = URL.createObjectURL(
        new Blob([prepared.plainBytes], { type: prepared.mimeType }),
      );

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
          messageType: 'image',
          ciphertext: null,
          cryptoHeader: null,
          reactions: [],
          replyToMeta: replyToPayload
            ? {
                messagePublicId: replyToPayload.messagePublicId,
                senderPublicId: replyToPayload.senderPublicId,
                seq: 0,
                messageType: replyToPayload.messageType,
                recalledAt: null,
                deletedForViewer: false,
              }
            : null,
          isPinned: false,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: nowIso,
        },
        plaintext: '',
        media: {
          kind: 'image',
          attachmentPublicId: '00000000-0000-4000-8000-000000000000',
          fileKey: '',
          fileIv: '',
          ciphertextSha256: '',
          mimeType: prepared.mimeType,
          sizeBytes: prepared.sizeBytes,
          width: prepared.width,
          height: prepared.height,
          ...(prepared.thumbnailDataUrl ? { thumbnailDataUrl: prepared.thumbnailDataUrl } : {}),
        },
        ...(replyToPayload ? { replyTo: replyToPayload } : {}),
        localPreviewUrl: tempPreviewUrl,
        decryptionFailed: false,
        sending: true,
        sendError: null,
      };

      updateThreadState(convId, (prev) => ({
        conversationPublicId: convId,
        items: [...(prev?.items ?? []), optimisticItem],
        nextBeforeSeq: prev?.nextBeforeSeq ?? null,
        highestSeq: Math.max(prev?.highestSeq ?? 0, optimisticSeq),
        hasInitialized: true,
        loadingInitial: false,
        loadingOlder: prev?.loadingOlder ?? false,
        lastAccessedAt: Date.now(),
      }));

      setPreviewsByConvId((prev) => ({
        ...prev,
        [convId]: `Bạn: ${IMAGE_MESSAGE_PREVIEW_LABEL}`,
      }));

      try {
        const encryptedBinary = await encryptMediaBinary({
          plainBytes: prepared.plainBytes,
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          mediaKind: 'image',
        });

        const tokenRes = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(convId)}/attachments/upload-token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mediaKind: 'image',
              ciphertextSizeBytes: encryptedBinary.ciphertextSizeBytes,
              ciphertextSha256: encryptedBinary.ciphertextSha256,
            }),
          },
        );
        if (!tokenRes.ok) {
          const errBody = (await tokenRes.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể gửi ảnh lúc này.');
        }

        const uploadGrant = (await tokenRes.json()) as CreateAttachmentUploadTokenResult;
        await uploadEncryptedAttachmentBinary(uploadGrant, encryptedBinary.ciphertextBytes);

        await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
        const [senderDevice, peerKeyBundle, ownBundle] = await Promise.all([
          getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
          ensureFreshPeerKeyBundleForEncryption(peerPublicId),
          ownKeyBundleRef.current
            ? Promise.resolve(ownKeyBundleRef.current)
            : refreshOwnE2eeStatus({ forceRefresh: true }),
        ]);

        if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
          throw new Error(
            `@${params.conversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào.`,
          );
        }

        const senderOtherDevices = await buildOwnSenderOtherDevices(ownBundle);
        const mediaPayload: DecryptedMessageMediaPayload = {
          kind: 'image',
          attachmentPublicId: uploadGrant.attachmentPublicId,
          fileKey: encryptedBinary.fileKey,
          fileIv: encryptedBinary.fileIv,
          ciphertextSha256: encryptedBinary.ciphertextSha256,
          mimeType: prepared.mimeType,
          sizeBytes: prepared.sizeBytes,
          width: prepared.width,
          height: prepared.height,
          ...(prepared.thumbnailDataUrl ? { thumbnailDataUrl: prepared.thumbnailDataUrl } : {}),
        };

        const envelope = await encryptDirectMessage({
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          plaintext: '',
          media: mediaPayload,
          ...(replyToPayload ? { replyTo: replyToPayload } : {}),
          senderDevice,
          recipientDevices: peerKeyBundle.devices,
          senderOtherDevices,
          sentAt: nowIso,
        });

        const response = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(convId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clientMsgId,
              messageType: 'image',
              attachmentPublicId: uploadGrant.attachmentPublicId,
              ciphertext: envelope.ciphertext,
              cryptoHeader: envelope.cryptoHeader,
              ...(replyToPayload ? { replyToMessagePublicId: replyToPayload.messagePublicId } : {}),
            }),
          },
        );
        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể gửi ảnh lúc này.');
        }

        const data = (await response.json()) as SendMessageResult;
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);

        putLruDecryptedMessageCache(
          targetStore.decryptedMessagesByCacheKey,
          buildMessageDecryptCacheKey(data.message),
          {
            plaintext: '',
            media: mediaPayload,
            ...(replyToPayload ? { replyTo: replyToPayload } : {}),
            decryptionFailed: false,
          },
        );

        // Chuyển quyền quản lý ObjectURL vào LRU cache chính thức theo `message.public_id`.
        putLruMediaObjectUrlCache(targetStore.mediaObjectUrlsByMsgId, {
          messagePublicId: data.message.public_id,
          conversationPublicId: convId,
          objectUrl: tempPreviewUrl,
          mimeType: prepared.mimeType,
        });

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
                    plaintext: '',
                    media: mediaPayload,
                    ...(replyToPayload ? { replyTo: replyToPayload } : {}),
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
          return sortPrimaryConversationsWithPins([data.conversation, ...filtered]);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Không thể gửi ảnh lúc này.';
        updateThreadState(convId, (prev) => ({
          conversationPublicId: convId,
          items: (prev?.items ?? []).map((item) =>
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
        }));
        throw error;
      }
    },
    [
      buildOwnSenderOtherDevices,
      currentUserPublicId,
      ensureFreshPeerKeyBundleForEncryption,
      refreshOwnE2eeStatus,
      selectConversation,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
      uploadEncryptedAttachmentBinary,
    ],
  );

  /**
   * Gửi tin nhắn thoại (Voice) mã hóa đầu cuối với Optimistic UI tức thì.
   */
  const sendOptimisticVoiceMessage = React.useCallback(
    async (params: {
      readonly conversation: ConversationSummaryDto;
      readonly audioBlob: Blob;
      readonly mimeType: string;
      readonly durationMs: number;
      readonly waveform: readonly number[];
      readonly replyTo?: DecryptedMessageReplyPayload | null;
    }) => {
      if (!params.conversation.canSendMedia) {
        throw new Error('Cuộc trò chuyện đang chờ chấp nhận nên chưa thể gửi tin nhắn thoại.');
      }

      const rawBytes = new Uint8Array(await params.audioBlob.arrayBuffer());
      const validated = validateVoiceBinaryInput({
        bytes: rawBytes,
        mimeType: params.mimeType,
        durationMs: params.durationMs,
      });
      const normalizedWaveform = normalizeWaveformBars(params.waveform);

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const convId = params.conversation.public_id;
      const peerPublicId = params.conversation.peer.public_id;
      const clientMsgId = `voc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const nowIso = new Date().toISOString();
      const replyToPayload = params.replyTo ?? undefined;
      const tempAudioUrl = URL.createObjectURL(new Blob([rawBytes], { type: validated.mimeType }));

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
          messageType: 'voice',
          ciphertext: null,
          cryptoHeader: null,
          reactions: [],
          replyToMeta: replyToPayload
            ? {
                messagePublicId: replyToPayload.messagePublicId,
                senderPublicId: replyToPayload.senderPublicId,
                seq: 0,
                messageType: replyToPayload.messageType,
                recalledAt: null,
                deletedForViewer: false,
              }
            : null,
          isPinned: false,
          editCount: 0,
          editedAt: null,
          recalledAt: null,
          createdAt: nowIso,
        },
        plaintext: '',
        media: {
          kind: 'voice',
          attachmentPublicId: '00000000-0000-4000-8000-000000000000',
          fileKey: '',
          fileIv: '',
          ciphertextSha256: '',
          mimeType: validated.mimeType,
          sizeBytes: rawBytes.byteLength,
          durationMs: validated.durationMs,
          waveform: normalizedWaveform,
        },
        ...(replyToPayload ? { replyTo: replyToPayload } : {}),
        localPreviewUrl: tempAudioUrl,
        decryptionFailed: false,
        sending: true,
        sendError: null,
      };

      updateThreadState(convId, (prev) => ({
        conversationPublicId: convId,
        items: [...(prev?.items ?? []), optimisticItem],
        nextBeforeSeq: prev?.nextBeforeSeq ?? null,
        highestSeq: Math.max(prev?.highestSeq ?? 0, optimisticSeq),
        hasInitialized: true,
        loadingInitial: false,
        loadingOlder: prev?.loadingOlder ?? false,
        lastAccessedAt: Date.now(),
      }));

      setPreviewsByConvId((prev) => ({
        ...prev,
        [convId]: `Bạn: ${VOICE_MESSAGE_PREVIEW_LABEL}`,
      }));

      try {
        const encryptedBinary = await encryptMediaBinary({
          plainBytes: rawBytes,
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          mediaKind: 'voice',
        });

        const tokenRes = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(convId)}/attachments/upload-token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mediaKind: 'voice',
              ciphertextSizeBytes: encryptedBinary.ciphertextSizeBytes,
              ciphertextSha256: encryptedBinary.ciphertextSha256,
            }),
          },
        );
        if (!tokenRes.ok) {
          const errBody = (await tokenRes.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể gửi tin nhắn thoại lúc này.');
        }

        const uploadGrant = (await tokenRes.json()) as CreateAttachmentUploadTokenResult;
        await uploadEncryptedAttachmentBinary(uploadGrant, encryptedBinary.ciphertextBytes);

        await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
        const [senderDevice, peerKeyBundle, ownBundle] = await Promise.all([
          getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
          ensureFreshPeerKeyBundleForEncryption(peerPublicId),
          ownKeyBundleRef.current
            ? Promise.resolve(ownKeyBundleRef.current)
            : refreshOwnE2eeStatus({ forceRefresh: true }),
        ]);

        if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
          throw new Error(
            `@${params.conversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào.`,
          );
        }

        const senderOtherDevices = await buildOwnSenderOtherDevices(ownBundle);
        const mediaPayload: DecryptedMessageMediaPayload = {
          kind: 'voice',
          attachmentPublicId: uploadGrant.attachmentPublicId,
          fileKey: encryptedBinary.fileKey,
          fileIv: encryptedBinary.fileIv,
          ciphertextSha256: encryptedBinary.ciphertextSha256,
          mimeType: validated.mimeType,
          sizeBytes: rawBytes.byteLength,
          durationMs: validated.durationMs,
          waveform: normalizedWaveform,
        };

        const envelope = await encryptDirectMessage({
          conversationPublicId: convId,
          senderPublicId: currentUserPublicId,
          clientMsgId,
          plaintext: '',
          media: mediaPayload,
          ...(replyToPayload ? { replyTo: replyToPayload } : {}),
          senderDevice,
          recipientDevices: peerKeyBundle.devices,
          senderOtherDevices,
          sentAt: nowIso,
        });

        const response = await authFetch(
          `/api/v1/conversations/${encodeURIComponent(convId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clientMsgId,
              messageType: 'voice',
              attachmentPublicId: uploadGrant.attachmentPublicId,
              ciphertext: envelope.ciphertext,
              cryptoHeader: envelope.cryptoHeader,
              ...(replyToPayload ? { replyToMessagePublicId: replyToPayload.messagePublicId } : {}),
            }),
          },
        );
        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể gửi tin nhắn thoại lúc này.');
        }

        const data = (await response.json()) as SendMessageResult;
        const targetStore = getOrInitUserChatRamCache(currentUserPublicId);

        putLruDecryptedMessageCache(
          targetStore.decryptedMessagesByCacheKey,
          buildMessageDecryptCacheKey(data.message),
          {
            plaintext: '',
            media: mediaPayload,
            ...(replyToPayload ? { replyTo: replyToPayload } : {}),
            decryptionFailed: false,
          },
        );

        putLruMediaObjectUrlCache(targetStore.mediaObjectUrlsByMsgId, {
          messagePublicId: data.message.public_id,
          conversationPublicId: convId,
          objectUrl: tempAudioUrl,
          mimeType: validated.mimeType,
        });

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
                    plaintext: '',
                    media: mediaPayload,
                    ...(replyToPayload ? { replyTo: replyToPayload } : {}),
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
          return sortPrimaryConversationsWithPins([data.conversation, ...filtered]);
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Không thể gửi tin nhắn thoại lúc này.';
        updateThreadState(convId, (prev) => ({
          conversationPublicId: convId,
          items: (prev?.items ?? []).map((item) =>
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
        }));
        throw error;
      }
    },
    [
      buildOwnSenderOtherDevices,
      currentUserPublicId,
      ensureFreshPeerKeyBundleForEncryption,
      refreshOwnE2eeStatus,
      selectConversation,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
      uploadEncryptedAttachmentBinary,
    ],
  );

  /**
   * Tải đúng 1 bản ghi tin nhắn vừa được chỉnh sửa qua `GET /api/v1/messages/[messagePublicId]`
   * rồi giải mã lại tại chỗ trong RAM (không phải tải lại toàn bộ đoạn chat).
   */
  const syncSingleUpdatedMessageFromServer = React.useCallback(
    async (conversationPublicId: string, messagePublicId: string) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const thread = store.threadsByConvId.get(conversationPublicId);
      const convSummary = resolveConversationById(conversationPublicId);
      const isInLoadedThread = Boolean(
        thread?.items.some((m) => m.dto.public_id === messagePublicId),
      );
      const isConversationPreviewMsg = convSummary?.lastMessage?.public_id === messagePublicId;

      if (!isInLoadedThread && !isConversationPreviewMsg) {
        return;
      }

      const existingReq = inFlightSingleMsgSyncRef.current.get(messagePublicId);
      if (existingReq) {
        return existingReq;
      }

      const task = (async () => {
        try {
          const peerPublicId = convSummary?.peer.public_id;
          const [res, peerBundle] = await Promise.all([
            authFetch(`/api/v1/messages/${encodeURIComponent(messagePublicId)}`),
            peerPublicId ? ensurePeerKeyBundle(peerPublicId) : Promise.resolve(null),
          ]);
          if (!res.ok) {
            return;
          }
          const body = (await res.json()) as { readonly message: ChatMessageDto };
          const updatedDto = body.message;
          const senderBundle = updatedDto.isOwnMessage ? ownKeyBundleRef.current : peerBundle;

          const decrypted = await decryptSingleMessageCached(updatedDto, senderBundle);

          if (store.threadsByConvId.has(conversationPublicId)) {
            updateThreadState(conversationPublicId, (prev) => {
              if (!prev) {
                return {
                  conversationPublicId,
                  items: [decrypted],
                  nextBeforeSeq: null,
                  highestSeq: updatedDto.seq,
                  hasInitialized: true,
                  loadingInitial: false,
                  loadingOlder: false,
                  lastAccessedAt: Date.now(),
                };
              }
              const nextItems = prev.items.map((item) =>
                item.dto.public_id === updatedDto.public_id ||
                item.dto.clientMsgId === updatedDto.clientMsgId
                  ? decrypted
                  : item,
              );
              return {
                ...prev,
                items: nextItems,
                lastAccessedAt: Date.now(),
              };
            });
          }

          const patchSummaryLastMessage = (c: ConversationSummaryDto): ConversationSummaryDto => {
            if (c.public_id !== conversationPublicId) {
              return c;
            }
            if (c.lastMessage?.public_id === updatedDto.public_id || updatedDto.seq >= c.lastSeq) {
              return {
                ...c,
                lastMessage: updatedDto,
              };
            }
            return c;
          };

          setPrimaryConversations((prev) => prev.map(patchSummaryLastMessage));
          setPendingConversations((prev) => prev.map(patchSummaryLastMessage));
          if (selectedConvRef.current?.public_id === conversationPublicId) {
            selectConversation(patchSummaryLastMessage(selectedConvRef.current));
          }

          const latestConv = resolveConversationById(conversationPublicId);
          if (
            !latestConv ||
            latestConv.lastMessage?.public_id === updatedDto.public_id ||
            updatedDto.seq >= latestConv.lastSeq
          ) {
            setPreviewsByConvId((prev) => ({
              ...prev,
              [conversationPublicId]: getConversationPreviewText(
                updatedDto,
                decrypted.plaintext,
                decrypted.decryptionFailed,
                { needsPinSync: pinSyncStateRef.current === 'needs_restore' },
              ),
            }));
          }
        } catch {
          // Bỏ qua lỗi mạng tạm thời.
        } finally {
          inFlightSingleMsgSyncRef.current.delete(messagePublicId);
        }
      })();

      inFlightSingleMsgSyncRef.current.set(messagePublicId, task);
      return task;
    },
    [
      currentUserPublicId,
      decryptSingleMessageCached,
      ensurePeerKeyBundle,
      resolveConversationById,
      selectConversation,
      setPendingConversations,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
    ],
  );

  const applyRecalledMessageLocally = React.useCallback(
    (
      conversationPublicId: string,
      messagePublicId: string,
      seq: number | null,
      recalledAt: string,
    ) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      purgeDecryptedMessageCacheByPublicId(store.decryptedMessagesByCacheKey, messagePublicId);
      revokeMediaObjectUrlByMessageId(store.mediaObjectUrlsByMsgId, messagePublicId);

      if (store.threadsByConvId.has(conversationPublicId)) {
        updateThreadState(conversationPublicId, (prev) => {
          if (!prev) {
            return {
              conversationPublicId,
              items: [],
              nextBeforeSeq: null,
              highestSeq: seq ?? 0,
              hasInitialized: false,
              loadingInitial: false,
              loadingOlder: false,
              lastAccessedAt: Date.now(),
            };
          }
          return {
            ...prev,
            items: prev.items.map((item) => {
              if (item.dto.public_id === messagePublicId) {
                if (item.localPreviewUrl) {
                  try {
                    URL.revokeObjectURL(item.localPreviewUrl);
                  } catch {
                    // Bỏ qua nếu đã giải phóng.
                  }
                }
                return {
                  ...item,
                  dto: {
                    ...item.dto,
                    ciphertext: null,
                    cryptoHeader: null,
                    reactions: [],
                    isPinned: false,
                    recalledAt,
                  },
                  plaintext: RECALLED_MESSAGE_PLACEHOLDER,
                  media: undefined,
                  localPreviewUrl: undefined,
                  decryptionFailed: false,
                };
              }

              // Cập nhật tức thì trích dẫn trả lời trỏ tới tin vừa thu hồi mà không cần F5.
              const repliesToRecalled =
                item.dto.replyToMeta?.messagePublicId === messagePublicId ||
                item.replyTo?.messagePublicId === messagePublicId;
              if (repliesToRecalled) {
                return {
                  ...item,
                  dto: {
                    ...item.dto,
                    replyToMeta: {
                      messagePublicId,
                      senderPublicId:
                        item.dto.replyToMeta?.senderPublicId ?? item.replyTo?.senderPublicId ?? '',
                      seq: item.dto.replyToMeta?.seq ?? seq ?? 0,
                      messageType:
                        item.dto.replyToMeta?.messageType ?? item.replyTo?.messageType ?? 'text',
                      recalledAt,
                      deletedForViewer: item.dto.replyToMeta?.deletedForViewer ?? false,
                    },
                  },
                };
              }

              return item;
            }),
            lastAccessedAt: Date.now(),
          };
        });
      }

      // Gỡ tin vừa thu hồi khỏi danh sách tin ghim trong RAM cache (nếu có).
      const cachedPins = store.pinnedByConvId.get(conversationPublicId);
      if (cachedPins && cachedPins.items.some((p) => p.message.dto.public_id === messagePublicId)) {
        const nextItems = cachedPins.items.filter(
          (p) => p.message.dto.public_id !== messagePublicId,
        );
        store.pinnedByConvId.set(conversationPublicId, {
          ...cachedPins,
          items: nextItems,
          totalPinnedCount: Math.max(nextItems.length, cachedPins.totalPinnedCount - 1),
        });
      }

      const isMatchingLast = (c: ConversationSummaryDto): boolean => {
        if (c.public_id !== conversationPublicId) {
          return false;
        }
        if (c.lastMessage?.public_id === messagePublicId) {
          return true;
        }
        return seq !== null && c.lastSeq === seq;
      };

      let affectedPreview = false;
      const patchSummary = (c: ConversationSummaryDto): ConversationSummaryDto => {
        if (!isMatchingLast(c)) {
          return c;
        }
        affectedPreview = true;
        return {
          ...c,
          lastMessage: c.lastMessage
            ? {
                ...c.lastMessage,
                ciphertext: null,
                cryptoHeader: null,
                recalledAt,
              }
            : null,
        };
      };

      setPrimaryConversations((prev) => prev.map(patchSummary));
      setPendingConversations((prev) => prev.map(patchSummary));
      if (selectedConvRef.current && isMatchingLast(selectedConvRef.current)) {
        selectConversation(patchSummary(selectedConvRef.current));
      }

      if (affectedPreview) {
        setPreviewsByConvId((prev) => ({
          ...prev,
          [conversationPublicId]: RECALLED_MESSAGE_PLACEHOLDER,
        }));
      }
      bumpThreadVersion();
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      selectConversation,
      setPendingConversations,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
    ],
  );

  const applyDeletedConversationLocally = React.useCallback(
    (
      conversationPublicId: string,
      serverCounts?: {
        readonly unreadConversationsCount?: number;
        readonly pendingCount?: number;
      },
    ) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const wasUnreadPrimary =
        store.unreadPrimaryConvIds.has(conversationPublicId) ||
        primaryConvsRef.current.some(
          (c) => c.public_id === conversationPublicId && isConversationUnread(c),
        );
      const wasPending = pendingConvsRef.current.some((c) => c.public_id === conversationPublicId);

      const prevThreadToClear = store.threadsByConvId.get(conversationPublicId);
      if (prevThreadToClear) {
        for (const item of prevThreadToClear.items) {
          if (item.localPreviewUrl) {
            try {
              URL.revokeObjectURL(item.localPreviewUrl);
            } catch {
              // Bỏ qua nếu đã giải phóng.
            }
          }
        }
      }
      revokeMediaObjectUrlsByConversationId(store.mediaObjectUrlsByMsgId, conversationPublicId);
      store.threadsByConvId.delete(conversationPublicId);
      store.pinnedByConvId.delete(conversationPublicId);
      store.unreadPrimaryConvIds.delete(conversationPublicId);
      store.lastSentReadSeqByConvId.delete(conversationPublicId);

      if (selectedConvRef.current?.public_id === conversationPublicId) {
        selectConversation(null);
      }
      if (floatingActiveConvIdRef.current === conversationPublicId) {
        floatingActiveConvIdRef.current = null;
      }

      setPrimaryConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      setPendingConversations((prev) => prev.filter((c) => c.public_id !== conversationPublicId));
      setPreviewsByConvId((prev) => {
        if (!(conversationPublicId in prev)) {
          return { ...prev };
        }
        const next = { ...prev };
        delete next[conversationPublicId];
        return next;
      });

      if (typeof serverCounts?.unreadConversationsCount === 'number') {
        setUnreadConversationsCount(serverCounts.unreadConversationsCount);
      } else if (wasUnreadPrimary) {
        setUnreadConversationsCount((count) =>
          Math.min(Math.max(0, count - 1), store.unreadPrimaryConvIds.size),
        );
      }

      if (typeof serverCounts?.pendingCount === 'number') {
        setPendingCount(serverCounts.pendingCount);
      } else if (wasPending) {
        setPendingCount((count) => Math.max(0, count - 1));
      }

      bumpThreadVersion();
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      selectConversation,
      setPendingConversations,
      setPendingCount,
      setPreviewsByConvId,
      setPrimaryConversations,
      setUnreadConversationsCount,
    ],
  );

  /**
   * Chỉnh sửa tin nhắn chữ trong 5 phút đầu (M10):
   * Sinh mới hoàn toàn contentKey 256-bit, IV 96-bit mới & chữ ký ECDSA P-256 trên AAD gốc,
   * gửi PATCH lên Server rồi cập nhật tức thì vào RAM cache & preview.
   */
  const editTextMessage = React.useCallback(
    async (params: {
      readonly conversation: ConversationSummaryDto;
      readonly message: DecryptedMessageViewItem;
      readonly newPlaintext: string;
    }) => {
      const trimmed = params.newPlaintext.trim();
      if (!trimmed) {
        return;
      }

      const convId = params.conversation.public_id;
      const peerPublicId = params.conversation.peer.public_id;
      const targetMsgId = params.message.dto.public_id;

      await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
      const [senderDevice, peerKeyBundle, ownBundle] = await Promise.all([
        getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
        ensureFreshPeerKeyBundleForEncryption(peerPublicId),
        ownKeyBundleRef.current
          ? Promise.resolve(ownKeyBundleRef.current)
          : refreshOwnE2eeStatus({ forceRefresh: true }),
      ]);

      if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
        throw new Error(
          `@${params.conversation.peer.handle} chưa kích hoạt hộp thư trên thiết bị nào.`,
        );
      }

      const senderOtherDevices = await buildOwnSenderOtherDevices(ownBundle);

      const envelope = await reEncryptEditedDirectMessage({
        conversationPublicId: convId,
        senderPublicId: currentUserPublicId,
        clientMsgId: params.message.dto.clientMsgId,
        plaintext: trimmed,
        ...(params.message.replyTo ? { replyTo: params.message.replyTo } : {}),
        ...(params.message.forwarded ? { forwarded: true } : {}),
        senderDevice,
        recipientDevices: peerKeyBundle.devices,
        senderOtherDevices,
        sentAt: params.message.dto.createdAt,
        previousIv: params.message.dto.cryptoHeader?.iv ?? null,
      });

      const response = await authFetch(`/api/v1/messages/${encodeURIComponent(targetMsgId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ciphertext: envelope.ciphertext,
          cryptoHeader: envelope.cryptoHeader,
        }),
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể chỉnh sửa tin nhắn lúc này.');
      }

      const data = (await response.json()) as { readonly message: ChatMessageDto };
      const updatedDto = data.message;
      const store = getOrInitUserChatRamCache(currentUserPublicId);

      purgeDecryptedMessageCacheByPublicId(store.decryptedMessagesByCacheKey, updatedDto.public_id);
      putLruDecryptedMessageCache(
        store.decryptedMessagesByCacheKey,
        buildMessageDecryptCacheKey(updatedDto),
        {
          plaintext: trimmed,
          ...(params.message.replyTo ? { replyTo: params.message.replyTo } : {}),
          ...(params.message.forwarded ? { forwarded: true } : {}),
          decryptionFailed: false,
        },
      );

      if (store.threadsByConvId.has(convId)) {
        updateThreadState(convId, (prev) => {
          if (!prev) {
            return {
              conversationPublicId: convId,
              items: [
                {
                  dto: updatedDto,
                  plaintext: trimmed,
                  decryptionFailed: false,
                },
              ],
              nextBeforeSeq: null,
              highestSeq: updatedDto.seq,
              hasInitialized: true,
              loadingInitial: false,
              loadingOlder: false,
              lastAccessedAt: Date.now(),
            };
          }
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.dto.public_id === updatedDto.public_id
                ? {
                    ...item,
                    dto: updatedDto,
                    plaintext: trimmed,
                    decryptionFailed: false,
                  }
                : item,
            ),
            lastAccessedAt: Date.now(),
          };
        });
      }

      const patchLastMsg = (c: ConversationSummaryDto): ConversationSummaryDto => {
        if (c.public_id !== convId) {
          return c;
        }
        if (c.lastMessage?.public_id === updatedDto.public_id || updatedDto.seq >= c.lastSeq) {
          return {
            ...c,
            lastMessage: updatedDto,
          };
        }
        return c;
      };
      setPrimaryConversations((prev) => prev.map(patchLastMsg));
      setPendingConversations((prev) => prev.map(patchLastMsg));
      if (selectedConvRef.current?.public_id === convId) {
        selectConversation(patchLastMsg(selectedConvRef.current));
      }

      const latestConv = resolveConversationById(convId);
      if (
        !latestConv ||
        latestConv.lastMessage?.public_id === updatedDto.public_id ||
        updatedDto.seq >= latestConv.lastSeq
      ) {
        setPreviewsByConvId((prev) => ({
          ...prev,
          [convId]: getConversationPreviewText(updatedDto, trimmed, false),
        }));
      }
    },
    [
      buildOwnSenderOtherDevices,
      currentUserPublicId,
      ensureFreshPeerKeyBundleForEncryption,
      refreshOwnE2eeStatus,
      resolveConversationById,
      selectConversation,
      setPendingConversations,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
    ],
  );

  /**
   * Thu hồi tin nhắn trong 5 phút đầu (M10).
   */
  const recallMessage = React.useCallback(
    async (params: { readonly conversationPublicId: string; readonly messagePublicId: string }) => {
      const response = await authFetch(
        `/api/v1/messages/${encodeURIComponent(params.messagePublicId)}/recall`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể thu hồi tin nhắn lúc này.');
      }

      const data = (await response.json()) as { readonly message: ChatMessageDto };
      applyRecalledMessageLocally(
        params.conversationPublicId,
        data.message.public_id,
        data.message.seq,
        data.message.recalledAt ?? new Date().toISOString(),
      );
    },
    [applyRecalledMessageLocally],
  );

  /**
   * Xóa 1 dòng tin nhắn chỉ ở phía mình (Optimistic UI + Rollback an toàn khi lỗi).
   */
  const deleteMessageForMe = React.useCallback(
    async (params: { readonly conversationPublicId: string; readonly messagePublicId: string }) => {
      const convId = params.conversationPublicId;
      const msgId = params.messagePublicId;
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const prevThread = store.threadsByConvId.get(convId) ?? null;
      const removedItem = prevThread?.items.find((m) => m.dto.public_id === msgId) ?? null;
      const removedIndex = prevThread?.items.findIndex((m) => m.dto.public_id === msgId) ?? -1;

      // Optimistic removal khỏi khung chat hiện tại.
      if (prevThread && removedItem) {
        updateThreadState(convId, (prev) => {
          if (!prev) {
            return prevThread;
          }
          return {
            ...prev,
            items: prev.items.filter((m) => m.dto.public_id !== msgId),
            lastAccessedAt: Date.now(),
          };
        });
      }

      try {
        const response = await authFetch(`/api/v1/messages/${encodeURIComponent(msgId)}/for-me`, {
          method: 'DELETE',
        });

        if (response.status === 404) {
          purgeDecryptedMessageCacheByPublicId(store.decryptedMessagesByCacheKey, msgId);
          revokeMediaObjectUrlByMessageId(store.mediaObjectUrlsByMsgId, msgId);
          return;
        }

        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể xóa tin nhắn lúc này.');
        }

        const data = (await response.json()) as DeleteMessageForMeResult;
        purgeDecryptedMessageCacheByPublicId(store.decryptedMessagesByCacheKey, msgId);
        revokeMediaObjectUrlByMessageId(store.mediaObjectUrlsByMsgId, msgId);
        const cachedPinsOnDelete = store.pinnedByConvId.get(convId);
        if (
          cachedPinsOnDelete &&
          cachedPinsOnDelete.items.some((p) => p.message.dto.public_id === msgId)
        ) {
          store.pinnedByConvId.set(convId, {
            ...cachedPinsOnDelete,
            items: cachedPinsOnDelete.items.filter((p) => p.message.dto.public_id !== msgId),
          });
          bumpThreadVersion();
        }
        if (removedItem?.localPreviewUrl) {
          try {
            URL.revokeObjectURL(removedItem.localPreviewUrl);
          } catch {
            // Bỏ qua nếu đã giải phóng.
          }
        }

        if (typeof data.unreadConversationsCount === 'number') {
          setUnreadConversationsCount(data.unreadConversationsCount);
        }

        const nextLast = data.nextLastMessage;
        let nextPreviewText = getConversationPreviewText(null);
        if (nextLast) {
          if (nextLast.recalledAt !== null) {
            nextPreviewText = RECALLED_MESSAGE_PLACEHOLDER;
          } else {
            const conv = resolveConversationById(convId);
            const peerBundle =
              !nextLast.isOwnMessage && conv
                ? await ensurePeerKeyBundle(conv.peer.public_id)
                : null;
            const senderBundle = nextLast.isOwnMessage ? ownKeyBundleRef.current : peerBundle;
            const dec = await decryptSingleMessageCached(nextLast, senderBundle);
            nextPreviewText = getConversationPreviewText(
              nextLast,
              dec.plaintext,
              dec.decryptionFailed,
              { needsPinSync: pinSyncStateRef.current === 'needs_restore' },
            );
          }
        }

        const patchLastMessage = (c: ConversationSummaryDto): ConversationSummaryDto =>
          c.public_id === convId ? { ...c, lastMessage: nextLast } : c;

        setPrimaryConversations((prev) => prev.map(patchLastMessage));
        setPendingConversations((prev) => prev.map(patchLastMessage));
        if (selectedConvRef.current?.public_id === convId) {
          selectConversation(patchLastMessage(selectedConvRef.current));
        }

        setPreviewsByConvId((prev) => ({
          ...prev,
          [convId]: nextPreviewText,
        }));
      } catch (error) {
        // Rollback đúng dòng bị lỗi nếu API thất bại.
        if (removedItem && removedIndex >= 0) {
          updateThreadState(convId, (prev) => {
            if (!prev) {
              return prevThread!;
            }
            if (prev.items.some((m) => m.dto.public_id === msgId)) {
              return prev;
            }
            const restored = [...prev.items, removedItem].sort((a, b) => a.dto.seq - b.dto.seq);
            return {
              ...prev,
              items: restored,
              lastAccessedAt: Date.now(),
            };
          });
        }
        throw error;
      }
    },
    [
      bumpThreadVersion,
      currentUserPublicId,
      decryptSingleMessageCached,
      ensurePeerKeyBundle,
      resolveConversationById,
      selectConversation,
      setPendingConversations,
      setPreviewsByConvId,
      setPrimaryConversations,
      setUnreadConversationsCount,
      updateThreadState,
    ],
  );

  /**
   * Xóa đoạn hội thoại ở phía mình (M10):
   * Xóa sạch khỏi danh sách RAM, cập nhật đồng bộ `unreadConversationsCount`,
   * và tự thoát đoạn chat trên cả `/messages` lẫn `FloatingMessagesWidget`.
   */
  const deleteConversationForMe = React.useCallback(
    async (conversationPublicId: string) => {
      const response = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(conversationPublicId)}`,
        { method: 'DELETE' },
      );

      if (response.status === 404) {
        applyDeletedConversationLocally(conversationPublicId);
        return;
      }

      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể xóa đoạn chat lúc này.');
      }

      const data = (await response.json()) as DeleteConversationForMeResult;
      applyDeletedConversationLocally(conversationPublicId, {
        unreadConversationsCount: data.unreadConversationsCount,
        pendingCount: data.pendingCount,
      });
    },
    [applyDeletedConversationLocally],
  );

  /**
   * Giải mã tệp ảnh/thoại thành `Uint8Array` trực tiếp trong RAM để chuyển tiếp sang hội thoại khác
   * (tuyệt đối KHÔNG gọi `fetch(blobUrl)` để tránh bị CSP `connect-src` chặn).
   */
  const decryptMessageMediaToRawBytes = React.useCallback(
    async (
      message: DecryptedMessageViewItem,
    ): Promise<{
      readonly plainBytes: Uint8Array<ArrayBuffer>;
      readonly mimeType: string;
    } | null> => {
      const media = message.media;
      if (
        !media ||
        message.decryptionFailed ||
        message.dto.recalledAt !== null ||
        message.sending ||
        message.dto.seq <= 0
      ) {
        return null;
      }

      const grantRes = await authFetch(
        `/api/v1/messages/${encodeURIComponent(message.dto.public_id)}/attachment`,
      );
      if (!grantRes.ok) {
        return null;
      }
      const grant = (await grantRes.json()) as MessageAttachmentDownloadGrantDto;
      if (grant.ciphertextSha256.toLowerCase() !== media.ciphertextSha256.toLowerCase()) {
        return null;
      }

      const binaryRes = grant.downloadUrl.startsWith('/')
        ? await authFetch(grant.downloadUrl)
        : await fetch(grant.downloadUrl, { credentials: 'omit' });
      if (!binaryRes.ok) {
        return null;
      }

      const ciphertextBytes = new Uint8Array(await binaryRes.arrayBuffer());
      const plainBytes = await decryptMediaBinary({
        ciphertextBytes,
        fileKey: media.fileKey,
        fileIv: media.fileIv,
        expectedSha256: media.ciphertextSha256,
        conversationPublicId: message.dto.conversationPublicId,
        senderPublicId: message.dto.senderPublicId,
        clientMsgId: message.dto.clientMsgId,
        mediaKind: media.kind,
      });

      return {
        plainBytes,
        mimeType: media.mimeType,
      };
    },
    [],
  );

  /**
   * Thả hoặc gỡ cảm xúc trên 1 tin nhắn (REST chuẩn: PUT khi thêm/đổi emoji, DELETE khi gỡ).
   */
  const reactToMessage = React.useCallback(
    async (params: {
      readonly conversationPublicId: string;
      readonly messagePublicId: string;
      readonly emoji: string | null;
    }) => {
      const { conversationPublicId, messagePublicId, emoji } = params;
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      const prevThread = store.threadsByConvId.get(conversationPublicId);
      const prevReactions =
        prevThread?.items.find((m) => m.dto.public_id === messagePublicId)?.dto.reactions ?? [];

      const applyReactionsToThread = (nextReactions: readonly MessageReactionDto[]) => {
        if (!store.threadsByConvId.has(conversationPublicId)) {
          return;
        }
        updateThreadState(conversationPublicId, (prev) => {
          if (!prev) {
            return {
              conversationPublicId,
              items: [],
              nextBeforeSeq: null,
              highestSeq: 0,
              hasInitialized: false,
              loadingInitial: false,
              loadingOlder: false,
              lastAccessedAt: Date.now(),
            };
          }
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.dto.public_id === messagePublicId
                ? {
                    ...item,
                    dto: {
                      ...item.dto,
                      reactions: nextReactions,
                    },
                  }
                : item,
            ),
            lastAccessedAt: Date.now(),
          };
        });
      };

      const optimisticReactions: MessageReactionDto[] = prevReactions.filter(
        (r) => r.userPublicId.toLowerCase() !== currentUserPublicId.toLowerCase(),
      );
      if (emoji !== null) {
        optimisticReactions.push({
          userPublicId: currentUserPublicId,
          emoji,
          updatedAt: new Date().toISOString(),
        });
      }
      applyReactionsToThread(optimisticReactions);

      try {
        const res =
          emoji !== null
            ? await authFetch(`/api/v1/messages/${encodeURIComponent(messagePublicId)}/reaction`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji }),
              })
            : await authFetch(`/api/v1/messages/${encodeURIComponent(messagePublicId)}/reaction`, {
                method: 'DELETE',
              });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? 'Không thể cập nhật cảm xúc lúc này.');
        }

        const data = (await res.json()) as MessageReactionMutationResult;
        applyReactionsToThread(data.reactions);
      } catch (error) {
        applyReactionsToThread(prevReactions);
        throw error;
      }
    },
    [currentUserPublicId, updateThreadState],
  );

  /**
   * Ghim 1 tin nhắn (tối đa 5 tin/hội thoại, hỗ trợ gỡ ghim tin cũ ẩn phía mình khi đầy).
   */
  const pinMessage = React.useCallback(
    async (params: {
      readonly conversationPublicId: string;
      readonly messagePublicId: string;
      readonly unpinOldestHiddenIfFull?: boolean;
    }): Promise<PinMessageOutcome> => {
      const res = await authFetch(
        `/api/v1/messages/${encodeURIComponent(params.messagePublicId)}/pin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            params.unpinOldestHiddenIfFull ? { unpinOldestHiddenIfFull: true } : {},
          ),
        },
      );

      if (res.status === 409) {
        const errBody = (await res.json().catch(() => null)) as {
          readonly error?: {
            readonly code?: string;
            readonly message?: string;
            readonly details?: ReadonlyArray<{
              readonly field?: string;
              readonly message?: string;
            }>;
          };
        } | null;
        const hiddenDetail = errBody?.error?.details?.find((d) => d.field === 'hiddenPinnedCount');
        const hiddenPinnedCount = hiddenDetail
          ? Number.parseInt(hiddenDetail.message ?? '0', 10) || 0
          : 0;
        return {
          ok: false,
          limitReached: errBody?.error?.code === 'CHAT_PINNED_MESSAGES_LIMIT_REACHED',
          hiddenPinnedCount,
          message:
            errBody?.error?.message ??
            'Đã đạt giới hạn tối đa 5 tin nhắn được ghim. Vui lòng gỡ ghim một tin nhắn trước khi ghim thêm.',
        };
      }

      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        return {
          ok: false,
          limitReached: false,
          hiddenPinnedCount: 0,
          message: errBody?.error?.message ?? 'Không thể ghim tin nhắn lúc này.',
        };
      }

      const data = (await res.json()) as MessagePinMutationResult;
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      if (store.threadsByConvId.has(params.conversationPublicId)) {
        updateThreadState(params.conversationPublicId, (prev) => {
          if (!prev) {
            return {
              conversationPublicId: params.conversationPublicId,
              items: [],
              nextBeforeSeq: null,
              highestSeq: 0,
              hasInitialized: false,
              loadingInitial: false,
              loadingOlder: false,
              lastAccessedAt: Date.now(),
            };
          }
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.dto.public_id === params.messagePublicId
                ? { ...item, dto: { ...item.dto, isPinned: true } }
                : item,
            ),
            lastAccessedAt: Date.now(),
          };
        });
      }

      void loadPinnedMessages(params.conversationPublicId, { force: true });
      return { ok: true, totalPinnedCount: data.totalPinnedCount };
    },
    [currentUserPublicId, loadPinnedMessages, updateThreadState],
  );

  const unpinMessage = React.useCallback(
    async (params: { readonly conversationPublicId: string; readonly messagePublicId: string }) => {
      const res = await authFetch(
        `/api/v1/messages/${encodeURIComponent(params.messagePublicId)}/pin`,
        { method: 'DELETE' },
      );

      if (!res.ok && res.status !== 404) {
        const errBody = (await res.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(errBody?.error?.message ?? 'Không thể gỡ ghim tin nhắn lúc này.');
      }

      const store = getOrInitUserChatRamCache(currentUserPublicId);
      if (store.threadsByConvId.has(params.conversationPublicId)) {
        updateThreadState(params.conversationPublicId, (prev) => {
          if (!prev) {
            return {
              conversationPublicId: params.conversationPublicId,
              items: [],
              nextBeforeSeq: null,
              highestSeq: 0,
              hasInitialized: false,
              loadingInitial: false,
              loadingOlder: false,
              lastAccessedAt: Date.now(),
            };
          }
          return {
            ...prev,
            items: prev.items.map((item) =>
              item.dto.public_id === params.messagePublicId
                ? { ...item, dto: { ...item.dto, isPinned: false } }
                : item,
            ),
            lastAccessedAt: Date.now(),
          };
        });
      }

      void loadPinnedMessages(params.conversationPublicId, { force: true });
    },
    [currentUserPublicId, loadPinnedMessages, updateThreadState],
  );

  /**
   * Ghim / bỏ ghim đoạn chat (tối đa 3) & Tắt / bật thông báo đoạn chat (riêng tư từng tài khoản).
   */
  const updateConversationPreferences = React.useCallback(
    async (params: {
      readonly conversationPublicId: string;
      readonly pinned?: boolean;
      readonly muted?: boolean;
    }): Promise<ConversationPreferencesResult> => {
      const res = await authFetch(
        `/api/v1/conversations/${encodeURIComponent(params.conversationPublicId)}/preferences`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
            ...(params.muted !== undefined ? { muted: params.muted } : {}),
          }),
        },
      );

      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        throw new Error(
          errBody?.error?.message ?? 'Không thể cập nhật tùy chọn cuộc trò chuyện lúc này.',
        );
      }

      const data = (await res.json()) as ConversationPreferencesResult;
      const store = getOrInitUserChatRamCache(currentUserPublicId);

      const patchConv = (c: ConversationSummaryDto): ConversationSummaryDto =>
        c.public_id === data.conversationPublicId
          ? {
              ...c,
              myState: {
                ...c.myState,
                pinnedAt: data.pinnedAt,
                mutedAt: data.mutedAt,
                isPinned: data.isPinned,
                isMuted: data.isMuted,
              },
            }
          : c;

      setPrimaryConversations((prev) => {
        const updated = sortPrimaryConversationsWithPins(prev.map(patchConv));
        store.unreadPrimaryConvIds.clear();
        for (const item of updated) {
          if (isConversationUnreadForBadge(item)) {
            store.unreadPrimaryConvIds.add(item.public_id);
          }
        }
        return updated;
      });
      setPendingConversations((prev) => prev.map(patchConv));
      if (selectedConvRef.current?.public_id === data.conversationPublicId) {
        selectConversation(patchConv(selectedConvRef.current));
      }
      setUnreadConversationsCount(data.unreadConversationsCount);

      return data;
    },
    [
      currentUserPublicId,
      selectConversation,
      setPendingConversations,
      setPrimaryConversations,
      setUnreadConversationsCount,
    ],
  );

  /**
   * Chuyển tiếp 1 tin nhắn (văn bản / ảnh / thoại) tới tối đa 5 người nhận đủ điều kiện
   * (Mutual Follow ∪ Đã từng trò chuyện). Mỗi người nhận được mã hóa lại độc lập (khóa & AAD mới)
   * và xử lý lỗi độc lập để 1 người lỗi không làm hỏng các người nhận hợp lệ khác.
   */
  const forwardMessageToRecipients = React.useCallback(
    async (params: {
      readonly sourceMessage: DecryptedMessageViewItem;
      readonly recipients: readonly ForwardTargetDto[];
    }): Promise<ForwardMessageBatchResult> => {
      const uniqueTargets = params.recipients.slice(0, MAX_FORWARD_RECIPIENTS);
      const succeeded: ForwardRecipientOutcome[] = [];
      const failed: ForwardRecipientOutcome[] = [];

      if (uniqueTargets.length === 0) {
        return { succeeded, failed };
      }

      const sourceType = params.sourceMessage.dto.messageType;
      if (
        sourceType === 'call_event' ||
        params.sourceMessage.dto.recalledAt !== null ||
        params.sourceMessage.decryptionFailed
      ) {
        for (const target of uniqueTargets) {
          failed.push({
            target,
            ok: false,
            errorMessage: 'Tin nhắn này hiện không thể chuyển tiếp.',
          });
        }
        return { succeeded, failed };
      }

      // Giải mã trực tiếp byte gốc trong RAM 1 lần duy nhất cho ảnh/thoại (KHÔNG dùng fetch(blobUrl)).
      let decryptedMediaBytes: {
        readonly plainBytes: Uint8Array<ArrayBuffer>;
        readonly mimeType: string;
      } | null = null;
      if (sourceType === 'image' || sourceType === 'voice') {
        decryptedMediaBytes = await decryptMessageMediaToRawBytes(params.sourceMessage);
        if (!decryptedMediaBytes || !params.sourceMessage.media) {
          for (const target of uniqueTargets) {
            failed.push({
              target,
              ok: false,
              errorMessage: 'Không thể tải tệp đính kèm để chuyển tiếp. Vui lòng thử lại.',
            });
          }
          return { succeeded, failed };
        }
      }

      await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
      const [senderDevice, ownBundle] = await Promise.all([
        getOrCreatePrimaryDeviceKeyMaterial(currentUserPublicId),
        ownKeyBundleRef.current
          ? Promise.resolve(ownKeyBundleRef.current)
          : refreshOwnE2eeStatus({ forceRefresh: true }),
      ]);
      const senderOtherDevices = await buildOwnSenderOtherDevices(ownBundle);

      for (const target of uniqueTargets) {
        try {
          const convRes = await authFetch('/api/v1/conversations/direct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipientPublicId: target.public_id,
              purpose: 'forward',
            }),
          });
          if (!convRes.ok) {
            const errBody = (await convRes.json().catch(() => null)) as {
              readonly error?: { readonly message?: string };
            } | null;
            failed.push({
              target,
              ok: false,
              errorMessage:
                errBody?.error?.message ?? 'Không thể chuyển tiếp tới tài khoản này lúc này.',
            });
            continue;
          }

          const convPayload = (await convRes.json()) as {
            readonly conversation: ConversationSummaryDto;
          };
          const targetConv = convPayload.conversation;

          const peerKeyBundle = await ensureFreshPeerKeyBundleForEncryption(target.public_id);
          if (!peerKeyBundle || peerKeyBundle.devices.length === 0) {
            failed.push({
              target,
              ok: false,
              errorMessage:
                'Người này chưa kích hoạt hộp thư nên tạm thời chưa nhận được tin chuyển tiếp.',
            });
            continue;
          }

          const nowIso = new Date().toISOString();
          const clientMsgId = `fwd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

          let attachmentPublicId: string | undefined;
          let mediaPayload: DecryptedMessageMediaPayload | undefined;

          if (
            (sourceType === 'image' || sourceType === 'voice') &&
            decryptedMediaBytes &&
            params.sourceMessage.media
          ) {
            const encryptedBinary = await encryptMediaBinary({
              plainBytes: decryptedMediaBytes.plainBytes,
              conversationPublicId: targetConv.public_id,
              senderPublicId: currentUserPublicId,
              clientMsgId,
              mediaKind: sourceType,
            });

            const tokenRes = await authFetch(
              `/api/v1/conversations/${encodeURIComponent(targetConv.public_id)}/attachments/upload-token`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  mediaKind: sourceType,
                  ciphertextSizeBytes: encryptedBinary.ciphertextSizeBytes,
                  ciphertextSha256: encryptedBinary.ciphertextSha256,
                }),
              },
            );
            if (!tokenRes.ok) {
              const errBody = (await tokenRes.json().catch(() => null)) as {
                readonly error?: { readonly message?: string };
              } | null;
              failed.push({
                target,
                ok: false,
                errorMessage:
                  errBody?.error?.message ?? 'Không thể tải tệp đính kèm khi chuyển tiếp.',
              });
              continue;
            }
            const uploadGrant = (await tokenRes.json()) as CreateAttachmentUploadTokenResult;
            await uploadEncryptedAttachmentBinary(uploadGrant, encryptedBinary.ciphertextBytes);

            attachmentPublicId = uploadGrant.attachmentPublicId;
            const srcMedia = params.sourceMessage.media;
            mediaPayload =
              sourceType === 'image'
                ? {
                    kind: 'image',
                    attachmentPublicId: uploadGrant.attachmentPublicId,
                    fileKey: encryptedBinary.fileKey,
                    fileIv: encryptedBinary.fileIv,
                    ciphertextSha256: encryptedBinary.ciphertextSha256,
                    mimeType: decryptedMediaBytes.mimeType,
                    sizeBytes: decryptedMediaBytes.plainBytes.byteLength,
                    width: srcMedia.width,
                    height: srcMedia.height,
                    ...(srcMedia.thumbnailDataUrl
                      ? { thumbnailDataUrl: srcMedia.thumbnailDataUrl }
                      : {}),
                  }
                : {
                    kind: 'voice',
                    attachmentPublicId: uploadGrant.attachmentPublicId,
                    fileKey: encryptedBinary.fileKey,
                    fileIv: encryptedBinary.fileIv,
                    ciphertextSha256: encryptedBinary.ciphertextSha256,
                    mimeType: decryptedMediaBytes.mimeType,
                    sizeBytes: decryptedMediaBytes.plainBytes.byteLength,
                    durationMs: srcMedia.durationMs,
                    waveform: srcMedia.waveform,
                  };
          }

          const plaintextToSend = sourceType === 'text' ? params.sourceMessage.plaintext : '';
          const envelope = await encryptDirectMessage({
            conversationPublicId: targetConv.public_id,
            senderPublicId: currentUserPublicId,
            clientMsgId,
            plaintext: plaintextToSend,
            ...(mediaPayload ? { media: mediaPayload } : {}),
            forwarded: true,
            senderDevice,
            recipientDevices: peerKeyBundle.devices,
            senderOtherDevices,
            sentAt: nowIso,
          });

          const sendRes = await authFetch(
            `/api/v1/conversations/${encodeURIComponent(targetConv.public_id)}/messages`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                clientMsgId,
                messageType: sourceType,
                ...(attachmentPublicId ? { attachmentPublicId } : {}),
                isForwarded: true,
                ciphertext: envelope.ciphertext,
                cryptoHeader: envelope.cryptoHeader,
              }),
            },
          );

          if (!sendRes.ok) {
            const errBody = (await sendRes.json().catch(() => null)) as {
              readonly error?: { readonly message?: string };
            } | null;
            failed.push({
              target,
              ok: false,
              errorMessage:
                errBody?.error?.message ?? 'Không thể gửi tin nhắn chuyển tiếp tới người này.',
            });
            continue;
          }

          const sentData = (await sendRes.json()) as SendMessageResult;
          const targetStore = getOrInitUserChatRamCache(currentUserPublicId);
          putLruDecryptedMessageCache(
            targetStore.decryptedMessagesByCacheKey,
            buildMessageDecryptCacheKey(sentData.message),
            {
              plaintext: plaintextToSend,
              ...(mediaPayload ? { media: mediaPayload } : {}),
              forwarded: true,
              decryptionFailed: false,
            },
          );

          if (targetStore.threadsByConvId.has(targetConv.public_id)) {
            updateThreadState(targetConv.public_id, (prev) => {
              if (!prev) {
                return {
                  conversationPublicId: targetConv.public_id,
                  items: [],
                  nextBeforeSeq: null,
                  highestSeq: sentData.message.seq,
                  hasInitialized: false,
                  loadingInitial: false,
                  loadingOlder: false,
                  lastAccessedAt: Date.now(),
                };
              }
              const exists = prev.items.some((m) => m.dto.public_id === sentData.message.public_id);
              const nextItems = exists
                ? prev.items
                : [
                    ...prev.items,
                    {
                      dto: sentData.message,
                      plaintext: plaintextToSend,
                      ...(mediaPayload ? { media: mediaPayload } : {}),
                      forwarded: true,
                      decryptionFailed: false,
                    },
                  ].sort((a, b) => a.dto.seq - b.dto.seq);
              return {
                ...prev,
                items: nextItems,
                highestSeq: Math.max(prev.highestSeq, sentData.message.seq),
                lastAccessedAt: Date.now(),
              };
            });
          }

          setPrimaryConversations((prev) => {
            const filtered = prev.filter((c) => c.public_id !== targetConv.public_id);
            return sortPrimaryConversationsWithPins([sentData.conversation, ...filtered]);
          });

          setPreviewsByConvId((prev) => ({
            ...prev,
            [targetConv.public_id]: getConversationPreviewText(
              sentData.message,
              plaintextToSend,
              false,
            ),
          }));

          succeeded.push({ target, ok: true });
        } catch (err) {
          failed.push({
            target,
            ok: false,
            errorMessage:
              err instanceof Error ? err.message : 'Không thể chuyển tiếp tới người này lúc này.',
          });
        }
      }

      if (succeeded.length > 0) {
        void loadConversations('primary', { background: true });
      }

      return { succeeded, failed };
    },
    [
      buildOwnSenderOtherDevices,
      currentUserPublicId,
      decryptMessageMediaToRawBytes,
      ensureFreshPeerKeyBundleForEncryption,
      loadConversations,
      refreshOwnE2eeStatus,
      setPreviewsByConvId,
      setPrimaryConversations,
      updateThreadState,
      uploadEncryptedAttachmentBinary,
    ],
  );

  /**
   * Nhảy tới tin nhắn gốc (từ trích dẫn trả lời hoặc danh sách Tin nhắn đã ghim):
   * Tự động tải tối đa 4 trang lịch sử cũ hơn (`MAX_JUMP_LOAD_PAGES`); tránh lặp vô hạn.
   */
  const jumpToMessageInConversation = React.useCallback(
    async (
      conversationPublicId: string,
      targetMessagePublicId: string,
    ): Promise<JumpToMessageResult> => {
      const hasTargetInRam = (): boolean => {
        const thread =
          getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(conversationPublicId);
        return Boolean(thread?.items.some((m) => m.dto.public_id === targetMessagePublicId));
      };

      if (hasTargetInRam()) {
        return { status: 'found', messagePublicId: targetMessagePublicId };
      }

      for (let attempt = 0; attempt < MAX_JUMP_LOAD_PAGES; attempt += 1) {
        const threadBefore =
          getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(conversationPublicId);
        if (!threadBefore || threadBefore.nextBeforeSeq === null) {
          break;
        }
        const loaded = await loadOlderMessages(conversationPublicId);
        if (hasTargetInRam()) {
          return { status: 'found', messagePublicId: targetMessagePublicId };
        }
        if (!loaded) {
          break;
        }
      }

      const threadAfter =
        getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(conversationPublicId);
      if (threadAfter && threadAfter.nextBeforeSeq !== null) {
        return {
          status: 'too_old',
          notice: 'Tin nhắn nằm ở phần lịch sử cũ hơn — hãy cuộn lên để xem',
        };
      }

      return {
        status: 'not_found',
        notice: 'Tin nhắn gốc không còn hiển thị trong cuộc trò chuyện này.',
      };
    },
    [currentUserPublicId, loadOlderMessages],
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
      revokeMediaObjectUrlsByConversationId(store.mediaObjectUrlsByMsgId, conversationPublicId);
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
      revokeMediaObjectUrlsByConversationId(store.mediaObjectUrlsByMsgId, conversationPublicId);
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

  /**
   * Đồng bộ tức thì toàn bộ RAM cache ngay sau khi Tạo / Khôi phục / Đổi / Đặt lại mã PIN:
   * 1. Chờ `refreshOwnE2eeStatus({ forceRefresh: true })` hoàn tất để `ownKeyBundleRef` và `pinSyncState` mới nhất sẵn sàng.
   * 2. Xóa toàn bộ bản ghi lỗi trong `decryptedMessagesByCacheKey`.
   * 3. Giải mã lại lập tức TẤT CẢ các luồng tin nhắn đang có trong `threadsByConvId` & dòng xem trước hội thoại.
   * 4. Gọi `bumpThreadVersion()` để cả `/messages` lẫn `FloatingMessagesWidget` hiện nội dung tức thì (0 lần F5).
   * 5. Kiểm tra & đánh dấu đã đọc các tin vừa hiển thị trong hội thoại đang mở (nếu thỏa `canAutoMarkConversationRead`).
   */
  const syncAfterPinOperation = React.useCallback(
    async (options: {
      readonly mode: 'created' | 'restored' | 'changed' | 'reset';
      readonly updatedBackup?: E2eeKeyBackupDto | null;
    }) => {
      const store = getOrInitUserChatRamCache(currentUserPublicId);
      if (options.updatedBackup !== undefined) {
        setCachedServerKeyBackupInSession(currentUserPublicId, options.updatedBackup);
        store.serverKeyBackup = options.updatedBackup;
        setServerKeyBackupState(options.updatedBackup);
      }

      const latestOwnBundle = await refreshOwnE2eeStatus({
        forceRefresh: true,
        forceBackupFetch: options.mode === 'changed' || options.mode === 'reset',
      });

      // Xóa sạch toàn bộ bản ghi giải mã thất bại khỏi RAM cache trước khi giải mã lại.
      for (const [cacheKey, entry] of Array.from(store.decryptedMessagesByCacheKey.entries())) {
        if (entry.decryptionFailed) {
          store.decryptedMessagesByCacheKey.delete(cacheKey);
        }
      }

      const allConvs = [...primaryConvsRef.current, ...pendingConvsRef.current];
      const peerByConvId = new Map<string, string>();
      for (const conv of allConvs) {
        peerByConvId.set(conv.public_id, conv.peer.public_id);
      }
      if (selectedConvRef.current) {
        peerByConvId.set(selectedConvRef.current.public_id, selectedConvRef.current.peer.public_id);
      }

      // Giải mã lại toàn bộ các luồng tin nhắn đã nạp trong RAM.
      const reDecryptedByConvId = new Map<string, readonly DecryptedMessageViewItem[]>();
      for (const [convId, thread] of Array.from(store.threadsByConvId.entries())) {
        const peerId = peerByConvId.get(convId);
        const peerBundle = peerId ? await ensurePeerKeyBundle(peerId) : null;
        const reDecryptedItems = await Promise.all(
          thread.items.map(async (item) => {
            if (!item.decryptionFailed) {
              return item;
            }
            const senderBundle = item.dto.isOwnMessage ? latestOwnBundle : peerBundle;
            return decryptSingleMessageCached(item.dto, senderBundle);
          }),
        );
        reDecryptedByConvId.set(convId, reDecryptedItems);
        putLruConversationThreadCache(store.threadsByConvId, convId, {
          ...thread,
          items: reDecryptedItems,
          lastAccessedAt: Date.now(),
        });
      }

      // Giải mã lại toàn bộ tin nhắn đã ghim đang có trong RAM cache (hỗ trợ mở khóa tức thì sau khi nhập mã PIN).
      for (const [convId, pinnedState] of Array.from(store.pinnedByConvId.entries())) {
        if (pinnedState.items.length === 0) {
          continue;
        }
        const peerId = peerByConvId.get(convId);
        const peerBundle = peerId ? await ensurePeerKeyBundle(peerId) : null;
        const reDecryptedPins: DecryptedPinnedMessageViewItem[] = await Promise.all(
          pinnedState.items.map(async (entry) => {
            if (!entry.message.decryptionFailed) {
              return entry;
            }
            const senderBundle = entry.message.dto.isOwnMessage ? latestOwnBundle : peerBundle;
            const dec = await decryptSingleMessageCached(entry.message.dto, senderBundle);
            return {
              ...entry,
              message: dec,
            };
          }),
        );
        store.pinnedByConvId.set(convId, {
          ...pinnedState,
          items: reDecryptedPins,
        });
      }

      // Giải mã lại toàn bộ dòng xem trước danh sách hội thoại (`primary` & `pending`).
      const nextNeedsPinSync = pinSyncStateRef.current === 'needs_restore';
      if (allConvs.length > 0) {
        const previewEntries = await Promise.all(
          allConvs.map(async (conv) => {
            if (!conv.lastMessage) {
              return [conv.public_id, getConversationPreviewText(null)] as const;
            }
            if (conv.lastMessage.recalledAt !== null) {
              return [conv.public_id, RECALLED_MESSAGE_PLACEHOLDER] as const;
            }
            const peerBundle = !conv.lastMessage.isOwnMessage
              ? await ensurePeerKeyBundle(conv.peer.public_id)
              : null;
            const senderBundle = conv.lastMessage.isOwnMessage ? latestOwnBundle : peerBundle;
            const dec = await decryptSingleMessageCached(conv.lastMessage, senderBundle);
            return [
              conv.public_id,
              getConversationPreviewText(conv.lastMessage, dec.plaintext, dec.decryptionFailed, {
                needsPinSync: nextNeedsPinSync,
              }),
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
      }

      bumpThreadVersion();

      // Đánh dấu đã đọc các tin vừa hiển thị trong hội thoại đang thực sự mở trên màn hình.
      const openCandidateIds = new Set<string>();
      if (selectedConvRef.current?.public_id) {
        openCandidateIds.add(selectedConvRef.current.public_id);
      }
      if (floatingActiveConvIdRef.current) {
        openCandidateIds.add(floatingActiveConvIdRef.current);
      }
      for (const convId of openCandidateIds) {
        const conv = resolveConversationById(convId);
        const items = reDecryptedByConvId.get(convId) ?? store.threadsByConvId.get(convId)?.items;
        if (!conv || !items || conv.myState.inboxState !== 'primary') {
          continue;
        }
        const highestVisibleSeq = computeHighestVisibleMessageSeq(items);
        if (highestVisibleSeq > 0 && checkCanAutoMarkRead(convId, highestVisibleSeq)) {
          void markConversationReadOptimistic(convId, highestVisibleSeq);
        }
      }

      // Làm mới ngầm danh sách hội thoại từ Server để bảo toàn tuyệt đối bộ lọc xóa M10 (`cleared_before_seq`, `message_user_deletions`).
      void loadConversations('primary', { background: true });
      if (store.hasLoadedPending || store.activeTab === 'pending') {
        void loadConversations('pending', { background: true });
      }
    },
    [
      bumpThreadVersion,
      checkCanAutoMarkRead,
      currentUserPublicId,
      decryptSingleMessageCached,
      ensurePeerKeyBundle,
      loadConversations,
      markConversationReadOptimistic,
      refreshOwnE2eeStatus,
      resolveConversationById,
      setPreviewsByConvId,
    ],
  );

  const setMessagesViewportActive = React.useCallback(
    (active: boolean) => {
      isMessagesViewportActiveRef.current = active;
      if (active) {
        const current = selectedConvRef.current;
        if (current) {
          const thread = getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(
            current.public_id,
          );
          const safeSeq = resolveSafeAutoReadSeq(
            current,
            thread?.hasInitialized ? thread.items : null,
          );
          if (safeSeq > 0 && checkCanAutoMarkRead(current.public_id, safeSeq)) {
            void markConversationReadOptimistic(current.public_id, safeSeq);
          }
        }
      }
    },
    [
      checkCanAutoMarkRead,
      currentUserPublicId,
      markConversationReadOptimistic,
      resolveSafeAutoReadSeq,
    ],
  );

  const setFloatingViewportConversation = React.useCallback(
    (conversationPublicId: string | null) => {
      floatingActiveConvIdRef.current = conversationPublicId;
      if (conversationPublicId) {
        const target = resolveConversationById(conversationPublicId);
        if (target) {
          const thread = getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(
            target.public_id,
          );
          const safeSeq = resolveSafeAutoReadSeq(
            target,
            thread?.hasInitialized ? thread.items : null,
          );
          if (safeSeq > 0 && checkCanAutoMarkRead(target.public_id, safeSeq)) {
            void markConversationReadOptimistic(target.public_id, safeSeq);
          }
        }
      }
    },
    [
      checkCanAutoMarkRead,
      currentUserPublicId,
      markConversationReadOptimistic,
      resolveConversationById,
      resolveSafeAutoReadSeq,
    ],
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
      const latestOwn = await refreshOwnE2eeStatus();
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
            const senderBundle = item.dto.isOwnMessage ? latestOwn : peerBundle;
            return decryptSingleMessageCached(item.dto, senderBundle);
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
            const isMutedConv = Boolean(existingPrimary?.myState.isMuted);
            if (!isMutedConv) {
              const wasAlreadyUnreadInList = existingPrimary
                ? isConversationUnreadForBadge(existingPrimary)
                : false;
              store.unreadPrimaryConvIds.add(convId);
              if (!wasAlreadyTrackedUnread && !wasAlreadyUnreadInList) {
                setUnreadConversationsCount((count) =>
                  Math.max(count + 1, store.unreadPrimaryConvIds.size),
                );
              }
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

      if (event.event === 'chat.message.updated') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const messagePublicId =
          typeof event.data.messagePublicId === 'string' ? event.data.messagePublicId : null;
        if (convId && messagePublicId) {
          void syncSingleUpdatedMessageFromServer(convId, messagePublicId);
        }
        return;
      }

      if (event.event === 'chat.message.recalled') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const messagePublicId =
          typeof event.data.messagePublicId === 'string' ? event.data.messagePublicId : null;
        const seq = typeof event.data.seq === 'number' ? event.data.seq : null;
        const recalledAt =
          typeof event.data.recalledAt === 'string'
            ? event.data.recalledAt
            : new Date().toISOString();
        if (convId && messagePublicId) {
          applyRecalledMessageLocally(convId, messagePublicId, seq, recalledAt);
        }
        return;
      }

      if (event.event === 'chat.message.deleted_for_me') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const messagePublicId =
          typeof event.data.messagePublicId === 'string' ? event.data.messagePublicId : null;
        const serverUnreadCount =
          typeof event.data.unreadConversationsCount === 'number'
            ? event.data.unreadConversationsCount
            : null;

        if (serverUnreadCount !== null) {
          setUnreadConversationsCount(serverUnreadCount);
        }

        if (convId && messagePublicId) {
          purgeDecryptedMessageCacheByPublicId(store.decryptedMessagesByCacheKey, messagePublicId);
          revokeMediaObjectUrlByMessageId(store.mediaObjectUrlsByMsgId, messagePublicId);
          if (store.threadsByConvId.has(convId)) {
            updateThreadState(convId, (prev) => {
              if (!prev) {
                return {
                  conversationPublicId: convId,
                  items: [],
                  nextBeforeSeq: null,
                  highestSeq: 0,
                  hasInitialized: false,
                  loadingInitial: false,
                  loadingOlder: false,
                  lastAccessedAt: Date.now(),
                };
              }
              return {
                ...prev,
                items: prev.items.filter((m) => m.dto.public_id !== messagePublicId),
                lastAccessedAt: Date.now(),
              };
            });
          }
          const conv = resolveConversationById(convId);
          if (conv?.lastMessage?.public_id === messagePublicId) {
            void loadConversations(conv.myState.inboxState === 'pending' ? 'pending' : 'primary', {
              background: true,
            });
          }
        }
        return;
      }

      if (event.event === 'chat.message.reaction.updated') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const messagePublicId =
          typeof event.data.messagePublicId === 'string' ? event.data.messagePublicId : null;
        const actorPublicId =
          typeof event.data.actorPublicId === 'string' ? event.data.actorPublicId : null;
        const emoji = typeof event.data.emoji === 'string' ? event.data.emoji : null;
        const updatedAt =
          typeof event.data.updatedAt === 'string'
            ? event.data.updatedAt
            : new Date().toISOString();

        if (convId && messagePublicId && actorPublicId && store.threadsByConvId.has(convId)) {
          updateThreadState(convId, (prev) => {
            if (!prev) {
              return {
                conversationPublicId: convId,
                items: [],
                nextBeforeSeq: null,
                highestSeq: 0,
                hasInitialized: false,
                loadingInitial: false,
                loadingOlder: false,
                lastAccessedAt: Date.now(),
              };
            }
            return {
              ...prev,
              items: prev.items.map((item) => {
                if (item.dto.public_id !== messagePublicId) {
                  return item;
                }
                const remaining = (item.dto.reactions ?? []).filter(
                  (r) => r.userPublicId.toLowerCase() !== actorPublicId.toLowerCase(),
                );
                const nextReactions: MessageReactionDto[] =
                  emoji !== null
                    ? [...remaining, { userPublicId: actorPublicId, emoji, updatedAt }]
                    : remaining;
                return {
                  ...item,
                  dto: {
                    ...item.dto,
                    reactions: nextReactions,
                  },
                };
              }),
              lastAccessedAt: Date.now(),
            };
          });
        }
        return;
      }

      if (event.event === 'chat.message.pin.updated') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const messagePublicId =
          typeof event.data.messagePublicId === 'string' ? event.data.messagePublicId : null;
        const pinned = event.data.pinned === true;

        if (convId && messagePublicId) {
          if (store.threadsByConvId.has(convId)) {
            updateThreadState(convId, (prev) => {
              if (!prev) {
                return {
                  conversationPublicId: convId,
                  items: [],
                  nextBeforeSeq: null,
                  highestSeq: 0,
                  hasInitialized: false,
                  loadingInitial: false,
                  loadingOlder: false,
                  lastAccessedAt: Date.now(),
                };
              }
              return {
                ...prev,
                items: prev.items.map((item) =>
                  item.dto.public_id === messagePublicId
                    ? { ...item, dto: { ...item.dto, isPinned: pinned } }
                    : item,
                ),
                lastAccessedAt: Date.now(),
              };
            });
          }
          if (
            store.pinnedByConvId.has(convId) ||
            selectedConvRef.current?.public_id === convId ||
            floatingActiveConvIdRef.current === convId
          ) {
            void loadPinnedMessages(convId, { force: true });
          }
        }
        return;
      }

      if (event.event === 'chat.conversation.preferences.updated') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        if (!convId) {
          return;
        }
        const pinnedAt = typeof event.data.pinnedAt === 'string' ? event.data.pinnedAt : null;
        const mutedAt = typeof event.data.mutedAt === 'string' ? event.data.mutedAt : null;
        const isPinned = event.data.isPinned === true || pinnedAt !== null;
        const isMuted = event.data.isMuted === true || mutedAt !== null;
        const serverUnreadCount =
          typeof event.data.unreadConversationsCount === 'number'
            ? event.data.unreadConversationsCount
            : null;

        const patchConv = (c: ConversationSummaryDto): ConversationSummaryDto =>
          c.public_id === convId
            ? {
                ...c,
                myState: {
                  ...c.myState,
                  pinnedAt,
                  mutedAt,
                  isPinned,
                  isMuted,
                },
              }
            : c;

        setPrimaryConversations((prev) => {
          const updated = sortPrimaryConversationsWithPins(prev.map(patchConv));
          store.unreadPrimaryConvIds.clear();
          for (const item of updated) {
            if (isConversationUnreadForBadge(item)) {
              store.unreadPrimaryConvIds.add(item.public_id);
            }
          }
          return updated;
        });
        setPendingConversations((prev) => prev.map(patchConv));
        if (selectedConvRef.current?.public_id === convId) {
          selectConversation(patchConv(selectedConvRef.current));
        }

        if (serverUnreadCount !== null) {
          setUnreadConversationsCount(serverUnreadCount);
        } else {
          setUnreadConversationsCount(store.unreadPrimaryConvIds.size);
        }
        return;
      }

      if (event.event === 'chat.conversation.deleted') {
        const convId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const serverUnreadCount =
          typeof event.data.unreadConversationsCount === 'number'
            ? event.data.unreadConversationsCount
            : undefined;
        const serverPendingCount =
          typeof event.data.pendingCount === 'number' ? event.data.pendingCount : undefined;
        if (convId) {
          applyDeletedConversationLocally(convId, {
            unreadConversationsCount: serverUnreadCount,
            pendingCount: serverPendingCount,
          });
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
    applyDeletedConversationLocally,
    applyRecalledMessageLocally,
    bumpThreadVersion,
    checkCanAutoMarkRead,
    currentUserPublicId,
    deltaSyncConversationThread,
    loadConversations,
    loadPinnedMessages,
    readReceiptsEnabled,
    resolveConversationById,
    selectConversation,
    setPendingConversations,
    setPrimaryConversations,
    setUnreadConversationsCount,
    subscribeChatEvents,
    syncSingleUpdatedMessageFromServer,
    updateThreadState,
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
        if (!conv) {
          continue;
        }
        const thread = getOrInitUserChatRamCache(currentUserPublicId).threadsByConvId.get(
          conv.public_id,
        );
        const safeSeq = resolveSafeAutoReadSeq(conv, thread?.hasInitialized ? thread.items : null);
        if (safeSeq > 0 && checkCanAutoMarkRead(conv.public_id, safeSeq)) {
          void markConversationReadOptimistic(conv.public_id, safeSeq);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, [
    checkCanAutoMarkRead,
    currentUserPublicId,
    markConversationReadOptimistic,
    resolveConversationById,
    resolveSafeAutoReadSeq,
  ]);

  const contextValue = React.useMemo<ChatStoreContextValue>(
    () => ({
      currentUserPublicId,
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
      pinSyncState,
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
      sendOptimisticImageMessage,
      sendOptimisticVoiceMessage,
      getPinnedState,
      loadPinnedMessages,
      reactToMessage,
      pinMessage,
      unpinMessage,
      updateConversationPreferences,
      forwardMessageToRecipients,
      jumpToMessageInConversation,
      resolveMessageMediaObjectUrl,
      getCachedMediaObjectUrl,
      editTextMessage,
      recallMessage,
      deleteMessageForMe,
      deleteConversationForMe,
      openOrCreateDirectConversation,
      acceptSelectedPendingConversation,
      declineSelectedPendingConversation,
      removeBlockedPeerConversationLocally,
      refreshOwnE2eeStatus,
      syncAfterPinOperation,
      clearAllChatCache,
    }),
    [
      acceptSelectedPendingConversation,
      activeTab,
      clearAllChatCache,
      currentUserPublicId,
      declineSelectedPendingConversation,
      deleteConversationForMe,
      deleteMessageForMe,
      editTextMessage,
      ensurePeerKeyBundle,
      forwardMessageToRecipients,
      getCachedMediaObjectUrl,
      getCachedPeerKeyBundle,
      getPinnedState,
      getThreadState,
      hasLoadedPending,
      hasLoadedPrimary,
      hasLocalRestoredBackup,
      jumpToMessageInConversation,
      loadConversations,
      loadOlderMessages,
      loadPinnedMessages,
      loadingConversations,
      markConversationReadOptimistic,
      openConversationThread,
      openOrCreateDirectConversation,
      ownKeyBundle,
      pendingConversations,
      pendingCount,
      pinMessage,
      pinSyncState,
      presences,
      previewsByConvId,
      primaryConversations,
      reactToMessage,
      recallMessage,
      refreshOwnE2eeStatus,
      removeBlockedPeerConversationLocally,
      resolveMessageMediaObjectUrl,
      selectConversation,
      selectedConversation,
      sendOptimisticImageMessage,
      sendOptimisticTextMessage,
      sendOptimisticVoiceMessage,
      serverKeyBackup,
      setActiveTab,
      setFloatingViewportConversation,
      setMessagesViewportActive,
      syncAfterPinOperation,
      threadVersion,
      unpinMessage,
      unreadConversationsCount,
      updateConversationPreferences,
    ],
  );

  return <ChatStoreContext.Provider value={contextValue}>{children}</ChatStoreContext.Provider>;
}
