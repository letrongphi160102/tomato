import * as React from 'react';

import type { GroupableMessageItem } from '@/components/messages/message-grouping';
import type { DecryptedMessageMediaPayload, DecryptedMessageReplyPayload } from '@/lib/e2ee/types';
import type {
  ConversationPreferencesResult,
  ConversationSummaryDto,
  E2eeKeyBackupDto,
  ForwardTargetDto,
  UserE2eeKeyBundleDto,
} from '@/modules/chat';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';

export const DEFAULT_MESSAGES_PAGE_LIMIT = 25;
export const MAX_LRU_CACHED_CONVERSATION_THREADS = 10;
export const MAX_LRU_CACHED_DECRYPTED_MESSAGES = 500;
export const MAX_LRU_CACHED_MEDIA_OBJECT_URLS = 60;
export const PEER_KEY_BUNDLE_CACHE_TTL_MS = 5 * 60 * 1000;

export type DecryptedMessageViewItem = GroupableMessageItem;

export type PinSyncState = 'loading' | 'must_create' | 'needs_restore' | 'synced';

/**
 * Suy dẫn chính xác trạng thái đồng bộ mã PIN trên thiết bị hiện tại:
 * - `loading`: chưa tải xong hồ sơ khóa từ Server.
 * - `must_create`: tài khoản chưa từng tạo mã PIN (`hasKeyBackup === false`).
 * - `needs_restore`: tài khoản đã có mã PIN nhưng IndexedDB thiết bị này chưa có khóa khớp `backupKeyFingerprint`.
 * - `synced`: thiết bị đã có đúng khóa đồng bộ phiên bản mới nhất (tránh lặp đòi PIN với tin cũ trước lần đặt lại).
 */
export function resolvePinSyncState(
  ownKeyBundle: UserE2eeKeyBundleDto | null,
  hasLocalRestoredBackup: boolean,
): PinSyncState {
  if (!ownKeyBundle) {
    return 'loading';
  }
  if (!ownKeyBundle.hasKeyBackup) {
    return 'must_create';
  }
  return hasLocalRestoredBackup ? 'synced' : 'needs_restore';
}

/**
 * Tìm số thứ tự `seq` lớn nhất trong số các tin nhắn THỰC SỰ HIỂN THỊ ĐƯỢC trên màn hình:
 * loại trừ tin đang gửi (`sending`), tin lỗi gửi (`sendError`) và đặc biệt là các tin cũ đang bị ẩn chờ mở khóa bằng mã PIN (`decryptionFailed`).
 * Dùng để bảo toàn logic "Đã xem": tuyệt đối không tự gửi `POST .../read` cho các tin nhắn đang bị ẩn.
 */
export function computeHighestVisibleMessageSeq(
  items: readonly DecryptedMessageViewItem[],
): number {
  let highest = 0;
  for (const item of items) {
    if (!item.decryptionFailed && !item.sending && !item.sendError && item.dto.seq > highest) {
      highest = item.dto.seq;
    }
  }
  return highest;
}

export interface CachedConversationThreadState {
  readonly conversationPublicId: string;
  readonly items: readonly DecryptedMessageViewItem[];
  readonly nextBeforeSeq: number | null;
  readonly highestSeq: number;
  readonly hasInitialized: boolean;
  readonly loadingInitial: boolean;
  readonly loadingOlder: boolean;
  readonly errorMessage?: string | null;
  readonly lastAccessedAt: number;
}

export interface DecryptedPinnedMessageViewItem {
  readonly message: DecryptedMessageViewItem;
  readonly pinnedAt: string;
  readonly pinnedByPublicId: string;
}

export interface CachedPinnedMessagesState {
  readonly conversationPublicId: string;
  readonly items: readonly DecryptedPinnedMessageViewItem[];
  readonly totalPinnedCount: number;
  readonly hiddenPinnedCount: number;
  readonly maxPinnedMessages: number;
  readonly loading: boolean;
  readonly hasLoaded: boolean;
}

export interface ForwardRecipientOutcome {
  readonly target: ForwardTargetDto;
  readonly ok: boolean;
  readonly errorMessage?: string;
}

export interface ForwardMessageBatchResult {
  readonly succeeded: readonly ForwardRecipientOutcome[];
  readonly failed: readonly ForwardRecipientOutcome[];
}

export type JumpToMessageResult =
  | { readonly status: 'found'; readonly messagePublicId: string }
  | { readonly status: 'too_old'; readonly notice: string }
  | { readonly status: 'not_found'; readonly notice: string };

export type PinMessageOutcome =
  | { readonly ok: true; readonly totalPinnedCount: number }
  | {
      readonly ok: false;
      readonly limitReached: boolean;
      readonly hiddenPinnedCount: number;
      readonly message: string;
    };

export interface ChatStoreContextValue {
  readonly currentUserPublicId: string;
  readonly activeTab: 'primary' | 'pending';
  readonly primaryConversations: readonly ConversationSummaryDto[];
  readonly pendingConversations: readonly ConversationSummaryDto[];
  readonly hasLoadedPrimary: boolean;
  readonly hasLoadedPending: boolean;
  readonly loadingConversations: boolean;
  readonly unreadConversationsCount: number;
  readonly pendingCount: number;
  readonly selectedConversation: ConversationSummaryDto | null;
  readonly previewsByConvId: Readonly<Record<string, string>>;
  readonly presences: Readonly<Record<string, PresenceStatusDto | null>>;
  readonly ownKeyBundle: UserE2eeKeyBundleDto | null;
  readonly serverKeyBackup: E2eeKeyBackupDto | null;
  readonly hasLocalRestoredBackup: boolean;
  readonly pinSyncState: PinSyncState;
  readonly threadVersion: number;
  readonly setActiveTab: (tab: 'primary' | 'pending') => void;
  readonly selectConversation: (conv: ConversationSummaryDto | null) => void;
  readonly setMessagesViewportActive: (active: boolean) => void;
  readonly setFloatingViewportConversation: (conversationPublicId: string | null) => void;
  readonly getThreadState: (conversationPublicId: string) => CachedConversationThreadState | null;
  readonly getCachedPeerKeyBundle: (peerPublicId: string) => UserE2eeKeyBundleDto | null;
  readonly ensurePeerKeyBundle: (
    peerPublicId: string,
    options?: { readonly forceRefresh?: boolean },
  ) => Promise<UserE2eeKeyBundleDto | null>;
  readonly loadConversations: (
    tab: 'primary' | 'pending',
    options?: { readonly background?: boolean },
  ) => Promise<void>;
  readonly openConversationThread: (
    conv: ConversationSummaryDto,
    options?: { readonly forceReload?: boolean },
  ) => Promise<void>;
  readonly loadOlderMessages: (conversationPublicId: string) => Promise<boolean>;
  readonly markConversationReadOptimistic: (
    conversationPublicId: string,
    targetSeq?: number,
  ) => Promise<void>;
  readonly sendOptimisticTextMessage: (params: {
    readonly conversation: ConversationSummaryDto;
    readonly plaintext: string;
    readonly replyTo?: DecryptedMessageReplyPayload | null;
    readonly retryClientMsgId?: string;
  }) => Promise<void>;
  readonly sendOptimisticImageMessage: (params: {
    readonly conversation: ConversationSummaryDto;
    readonly file: File | Blob;
    readonly replyTo?: DecryptedMessageReplyPayload | null;
  }) => Promise<void>;
  readonly sendOptimisticVoiceMessage: (params: {
    readonly conversation: ConversationSummaryDto;
    readonly audioBlob: Blob;
    readonly mimeType: string;
    readonly durationMs: number;
    readonly waveform: readonly number[];
    readonly replyTo?: DecryptedMessageReplyPayload | null;
  }) => Promise<void>;
  readonly getPinnedState: (conversationPublicId: string) => CachedPinnedMessagesState | null;
  readonly loadPinnedMessages: (
    conversationPublicId: string,
    options?: { readonly force?: boolean },
  ) => Promise<CachedPinnedMessagesState | null>;
  readonly reactToMessage: (params: {
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
    readonly emoji: string | null;
  }) => Promise<void>;
  readonly pinMessage: (params: {
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
    readonly unpinOldestHiddenIfFull?: boolean;
  }) => Promise<PinMessageOutcome>;
  readonly unpinMessage: (params: {
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
  }) => Promise<void>;
  readonly updateConversationPreferences: (params: {
    readonly conversationPublicId: string;
    readonly pinned?: boolean;
    readonly muted?: boolean;
  }) => Promise<ConversationPreferencesResult>;
  readonly forwardMessageToRecipients: (params: {
    readonly sourceMessage: DecryptedMessageViewItem;
    readonly recipients: readonly ForwardTargetDto[];
  }) => Promise<ForwardMessageBatchResult>;
  readonly jumpToMessageInConversation: (
    conversationPublicId: string,
    targetMessagePublicId: string,
  ) => Promise<JumpToMessageResult>;
  readonly resolveMessageMediaObjectUrl: (
    message: DecryptedMessageViewItem,
  ) => Promise<string | null>;
  readonly getCachedMediaObjectUrl: (messagePublicId: string) => string | null;
  readonly editTextMessage: (params: {
    readonly conversation: ConversationSummaryDto;
    readonly message: DecryptedMessageViewItem;
    readonly newPlaintext: string;
  }) => Promise<void>;
  readonly recallMessage: (params: {
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
  }) => Promise<void>;
  readonly deleteMessageForMe: (params: {
    readonly conversationPublicId: string;
    readonly messagePublicId: string;
  }) => Promise<void>;
  readonly deleteConversationForMe: (conversationPublicId: string) => Promise<void>;
  readonly openOrCreateDirectConversation: (
    recipientPublicId: string,
  ) => Promise<ConversationSummaryDto>;
  readonly acceptSelectedPendingConversation: (conversationPublicId: string) => Promise<void>;
  readonly declineSelectedPendingConversation: (conversationPublicId: string) => Promise<void>;
  readonly removeBlockedPeerConversationLocally: (conversationPublicId: string) => void;
  readonly refreshOwnE2eeStatus: (options?: {
    readonly forceBackupFetch?: boolean;
    readonly forceRefresh?: boolean;
  }) => Promise<UserE2eeKeyBundleDto | null>;
  readonly syncAfterPinOperation: (options: {
    readonly mode: 'created' | 'restored' | 'changed' | 'reset';
    readonly updatedBackup?: E2eeKeyBackupDto | null;
  }) => Promise<void>;
  readonly clearAllChatCache: () => void;
}

export const ChatStoreContext = React.createContext<ChatStoreContextValue | null>(null);
export const ChatUnreadContext = React.createContext<number>(0);
export const ChatLogoutActionsContext = React.createContext<{
  readonly clearAllChatCache: () => void;
} | null>(null);

export function useChatStore(): ChatStoreContextValue | null {
  return React.useContext(ChatStoreContext);
}

export function useChatUnreadCount(): number {
  return React.useContext(ChatUnreadContext);
}

export function useChatLogoutActions(): { readonly clearAllChatCache: () => void } | null {
  return React.useContext(ChatLogoutActionsContext);
}

// ============================================================================
// Bộ nhớ đệm RAM cấp phiên (Chỉ lưu trong JS Heap RAM — 0% localStorage/sessionStorage)
// ============================================================================

export interface DecryptedMessageCacheEntry {
  readonly plaintext: string;
  readonly media?: DecryptedMessageMediaPayload;
  readonly replyTo?: DecryptedMessageReplyPayload;
  readonly forwarded?: boolean;
  readonly decryptionFailed: boolean;
}

export interface DecryptedMediaObjectUrlCacheEntry {
  readonly messagePublicId: string;
  readonly conversationPublicId: string;
  readonly objectUrl: string;
  readonly mimeType: string;
}

export interface PeerKeyBundleCacheEntry {
  readonly bundle: UserE2eeKeyBundleDto;
  readonly expiresAt: number;
}

export interface UserChatRamCache {
  readonly userPublicId: string;
  activeTab: 'primary' | 'pending';
  primaryConversations: readonly ConversationSummaryDto[];
  pendingConversations: readonly ConversationSummaryDto[];
  hasLoadedPrimary: boolean;
  hasLoadedPending: boolean;
  unreadConversationsCount: number;
  pendingCount: number;
  selectedConversation: ConversationSummaryDto | null;
  previewsByConvId: Record<string, string>;
  presences: Record<string, PresenceStatusDto | null>;
  ownKeyBundle: UserE2eeKeyBundleDto | null;
  serverKeyBackup: E2eeKeyBackupDto | null;
  hasLocalRestoredBackup: boolean;
  readonly threadsByConvId: Map<string, CachedConversationThreadState>;
  readonly pinnedByConvId: Map<string, CachedPinnedMessagesState>;
  readonly decryptedMessagesByCacheKey: Map<string, DecryptedMessageCacheEntry>;
  readonly mediaObjectUrlsByMsgId: Map<string, DecryptedMediaObjectUrlCacheEntry>;
  readonly peerKeyBundlesByUserId: Map<string, PeerKeyBundleCacheEntry>;
  readonly lastSentReadSeqByConvId: Map<string, number>;
  readonly unreadPrimaryConvIds: Set<string>;
}

function safeRevokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Bỏ qua nếu trình duyệt đã giải phóng ObjectURL trước đó.
  }
}

let activeUserChatRamCache: UserChatRamCache | null = null;
let chatRamCacheEpoch = 0;

export function getChatRamCacheEpoch(): number {
  return chatRamCacheEpoch;
}

export function revokeThreadLocalPreviewUrls(
  thread: CachedConversationThreadState | null | undefined,
): void {
  if (!thread) {
    return;
  }
  for (const item of thread.items) {
    safeRevokeObjectUrl(item.localPreviewUrl);
  }
}

export function getOrInitUserChatRamCache(userPublicId: string): UserChatRamCache {
  const norm = userPublicId.trim().toLowerCase();
  if (activeUserChatRamCache && activeUserChatRamCache.userPublicId === norm) {
    return activeUserChatRamCache;
  }

  // Khi chuyển tài khoản: bắt buộc giải phóng sạch mọi ObjectURL đã giải mã của tài khoản trước.
  if (activeUserChatRamCache) {
    clearChatRamMemorySingleton();
  }

  activeUserChatRamCache = {
    userPublicId: norm,
    activeTab: 'primary',
    primaryConversations: [],
    pendingConversations: [],
    hasLoadedPrimary: false,
    hasLoadedPending: false,
    unreadConversationsCount: 0,
    pendingCount: 0,
    selectedConversation: null,
    previewsByConvId: {},
    presences: {},
    ownKeyBundle: null,
    serverKeyBackup: null,
    hasLocalRestoredBackup: false,
    threadsByConvId: new Map(),
    pinnedByConvId: new Map(),
    decryptedMessagesByCacheKey: new Map(),
    mediaObjectUrlsByMsgId: new Map(),
    peerKeyBundlesByUserId: new Map(),
    lastSentReadSeqByConvId: new Map(),
    unreadPrimaryConvIds: new Set(),
  };

  return activeUserChatRamCache;
}

export function clearChatRamMemorySingleton(): void {
  chatRamCacheEpoch += 1;
  if (activeUserChatRamCache) {
    for (const entry of activeUserChatRamCache.mediaObjectUrlsByMsgId.values()) {
      safeRevokeObjectUrl(entry.objectUrl);
    }
    for (const thread of activeUserChatRamCache.threadsByConvId.values()) {
      for (const item of thread.items) {
        safeRevokeObjectUrl(item.localPreviewUrl);
      }
    }
    activeUserChatRamCache.mediaObjectUrlsByMsgId.clear();
    activeUserChatRamCache.threadsByConvId.clear();
    activeUserChatRamCache.pinnedByConvId.clear();
    activeUserChatRamCache.decryptedMessagesByCacheKey.clear();
    activeUserChatRamCache.peerKeyBundlesByUserId.clear();
    activeUserChatRamCache.lastSentReadSeqByConvId.clear();
    activeUserChatRamCache.unreadPrimaryConvIds.clear();
    activeUserChatRamCache.primaryConversations = [];
    activeUserChatRamCache.pendingConversations = [];
    activeUserChatRamCache.previewsByConvId = {};
    activeUserChatRamCache.presences = {};
    activeUserChatRamCache.selectedConversation = null;
    activeUserChatRamCache.ownKeyBundle = null;
    activeUserChatRamCache.serverKeyBackup = null;
  }
  activeUserChatRamCache = null;
}

export function putLruMediaObjectUrlCache(
  map: Map<string, DecryptedMediaObjectUrlCacheEntry>,
  entry: DecryptedMediaObjectUrlCacheEntry,
): void {
  const existing = map.get(entry.messagePublicId);
  if (existing) {
    if (existing.objectUrl !== entry.objectUrl) {
      safeRevokeObjectUrl(existing.objectUrl);
    }
    map.delete(entry.messagePublicId);
  }
  map.set(entry.messagePublicId, entry);
  while (map.size > MAX_LRU_CACHED_MEDIA_OBJECT_URLS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const evicted = map.get(oldestKey);
    if (evicted) {
      safeRevokeObjectUrl(evicted.objectUrl);
    }
    map.delete(oldestKey);
  }
}

export function revokeMediaObjectUrlByMessageId(
  map: Map<string, DecryptedMediaObjectUrlCacheEntry>,
  messagePublicId: string,
): void {
  const existing = map.get(messagePublicId);
  if (existing) {
    safeRevokeObjectUrl(existing.objectUrl);
    map.delete(messagePublicId);
  }
}

export function revokeMediaObjectUrlsByConversationId(
  map: Map<string, DecryptedMediaObjectUrlCacheEntry>,
  conversationPublicId: string,
): void {
  for (const [key, entry] of Array.from(map.entries())) {
    if (entry.conversationPublicId === conversationPublicId) {
      safeRevokeObjectUrl(entry.objectUrl);
      map.delete(key);
    }
  }
}

/**
 * Nút nổi & Cửa sổ Tin nhắn Thu gọn góc dưới bên phải CHỈ hiển thị tại:
 * - Trang chủ (`/`)
 * - Trang cá nhân (`/u/[handle]`)
 * Tự động ẩn hoàn toàn tại `/messages`, `/settings/*` và các trang khác.
 */
export function shouldRenderFloatingMessagesWidget(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }
  return pathname === '/' || pathname.startsWith('/u/');
}

export interface AutoMarkConversationReadCheckParams {
  readonly pathname: string | null | undefined;
  readonly isMessagesViewportActive: boolean;
  readonly selectedConversation: ConversationSummaryDto | null;
  readonly floatingActiveConversationPublicId?: string | null;
  readonly floatingConversation?: ConversationSummaryDto | null;
  readonly targetConversationPublicId: string;
  readonly targetSeq: number;
  readonly documentVisibilityState: DocumentVisibilityState | string;
  readonly windowHasFocus?: boolean;
}

/**
 * Khóa chặt 4 điều kiện bắt buộc trước khi tự động gửi `POST /api/v1/conversations/[id]/read`:
 * (a) Người dùng đang thực sự mở đoạn chat đó ở một trong hai nơi:
 *     - (a1) Trang `/messages` đang mount (`pathname.startsWith('/messages') && isMessagesViewportActive`), HOẶC
 *     - (a2) Cửa sổ Tin nhắn nổi trên `/` hoặc `/u/[handle]` đang mở ở màn hình trò chuyện của đúng đoạn chat đó
 *            (`floatingActiveConversationPublicId === targetConversationPublicId`).
 * (b) Đoạn chat đó thuộc hộp thư `Chính` (`primary`).
 * (c) Tab trình duyệt đang hiển thị (`visible`) và cửa sổ đang có tiêu điểm (`windowHasFocus !== false`).
 * (d) Có tin nhắn mới từ đối phương (`targetSeq > lastReadSeq`).
 */
export function canAutoMarkConversationRead(params: AutoMarkConversationReadCheckParams): boolean {
  if (params.documentVisibilityState !== 'visible') {
    return false;
  }
  if (params.windowHasFocus === false) {
    return false;
  }

  const isOnMessagesPage = Boolean(params.pathname && params.pathname.startsWith('/messages'));
  const isOnFloatingAllowedPage = shouldRenderFloatingMessagesWidget(params.pathname);

  let activeConv: ConversationSummaryDto | null = null;

  if (
    isOnMessagesPage &&
    params.isMessagesViewportActive &&
    params.selectedConversation &&
    params.selectedConversation.public_id === params.targetConversationPublicId
  ) {
    activeConv = params.selectedConversation;
  } else if (
    isOnFloatingAllowedPage &&
    params.floatingActiveConversationPublicId &&
    params.floatingActiveConversationPublicId === params.targetConversationPublicId
  ) {
    const candidate = params.floatingConversation ?? params.selectedConversation;
    if (candidate && candidate.public_id === params.targetConversationPublicId) {
      activeConv = candidate;
    }
  }

  if (!activeConv) {
    return false;
  }
  if (activeConv.myState.inboxState !== 'primary') {
    return false;
  }
  const effectiveReadFloor = Math.max(
    activeConv.myState.lastReadSeq,
    activeConv.myState.clearedBeforeSeq ?? 0,
  );
  if (params.targetSeq <= effectiveReadFloor) {
    return false;
  }
  return true;
}

export function buildMessageDecryptCacheKey(message: {
  readonly public_id: string;
  readonly editedAt: string | null;
  readonly recalledAt: string | null;
}): string {
  return `${message.public_id}:${message.editedAt ?? ''}:${message.recalledAt ?? ''}`;
}

export function purgeDecryptedMessageCacheByPublicId(
  map: Map<string, DecryptedMessageCacheEntry>,
  messagePublicId: string,
): void {
  const prefix = `${messagePublicId}:`;
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(prefix)) {
      map.delete(key);
    }
  }
}

export function putLruDecryptedMessageCache(
  map: Map<string, DecryptedMessageCacheEntry>,
  cacheKey: string,
  entry: DecryptedMessageCacheEntry,
): void {
  if (map.has(cacheKey)) {
    map.delete(cacheKey);
  }
  map.set(cacheKey, entry);
  while (map.size > MAX_LRU_CACHED_DECRYPTED_MESSAGES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

export function putLruConversationThreadCache(
  map: Map<string, CachedConversationThreadState>,
  conversationPublicId: string,
  state: CachedConversationThreadState,
  mediaObjectUrlsByMsgId?: Map<string, DecryptedMediaObjectUrlCacheEntry>,
): void {
  if (map.has(conversationPublicId)) {
    map.delete(conversationPublicId);
  }
  map.set(conversationPublicId, state);
  while (map.size > MAX_LRU_CACHED_CONVERSATION_THREADS) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [k, v] of map.entries()) {
      if (v.lastAccessedAt < oldestTime) {
        oldestTime = v.lastAccessedAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) {
      break;
    }
    const evictedThread = map.get(oldestKey);
    revokeThreadLocalPreviewUrls(evictedThread);
    if (mediaObjectUrlsByMsgId) {
      revokeMediaObjectUrlsByConversationId(mediaObjectUrlsByMsgId, oldestKey);
    }
    map.delete(oldestKey);
  }
}
