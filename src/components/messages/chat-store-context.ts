import * as React from 'react';

import type { GroupableMessageItem } from '@/components/messages/message-grouping';
import type {
  ConversationSummaryDto,
  E2eeKeyBackupDto,
  UserE2eeKeyBundleDto,
} from '@/modules/chat';
import type { PresenceStatusDto } from '@/modules/presence/presence.service';

export const DEFAULT_MESSAGES_PAGE_LIMIT = 25;
export const MAX_LRU_CACHED_CONVERSATION_THREADS = 10;
export const MAX_LRU_CACHED_DECRYPTED_MESSAGES = 500;
export const PEER_KEY_BUNDLE_CACHE_TTL_MS = 5 * 60 * 1000;

export type DecryptedMessageViewItem = GroupableMessageItem;

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

export interface ChatStoreContextValue {
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
    readonly retryClientMsgId?: string;
  }) => Promise<void>;
  readonly openOrCreateDirectConversation: (
    recipientPublicId: string,
  ) => Promise<ConversationSummaryDto>;
  readonly acceptSelectedPendingConversation: (conversationPublicId: string) => Promise<void>;
  readonly declineSelectedPendingConversation: (conversationPublicId: string) => Promise<void>;
  readonly removeBlockedPeerConversationLocally: (conversationPublicId: string) => void;
  readonly refreshOwnE2eeStatus: (options?: {
    readonly forceBackupFetch?: boolean;
  }) => Promise<void>;
  readonly clearAllChatCache: () => void;
}

export const ChatStoreContext = React.createContext<ChatStoreContextValue | null>(null);

export function useChatStore(): ChatStoreContextValue | null {
  return React.useContext(ChatStoreContext);
}

// ============================================================================
// Bộ nhớ đệm RAM cấp phiên (Chỉ lưu trong JS Heap RAM — 0% localStorage/sessionStorage)
// ============================================================================

export interface DecryptedMessageCacheEntry {
  readonly plaintext: string;
  readonly decryptionFailed: boolean;
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
  readonly decryptedMessagesByCacheKey: Map<string, DecryptedMessageCacheEntry>;
  readonly peerKeyBundlesByUserId: Map<string, PeerKeyBundleCacheEntry>;
  readonly lastSentReadSeqByConvId: Map<string, number>;
  readonly unreadPrimaryConvIds: Set<string>;
}

let activeUserChatRamCache: UserChatRamCache | null = null;

export function getOrInitUserChatRamCache(userPublicId: string): UserChatRamCache {
  const norm = userPublicId.trim().toLowerCase();
  if (activeUserChatRamCache && activeUserChatRamCache.userPublicId === norm) {
    return activeUserChatRamCache;
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
    decryptedMessagesByCacheKey: new Map(),
    peerKeyBundlesByUserId: new Map(),
    lastSentReadSeqByConvId: new Map(),
    unreadPrimaryConvIds: new Set(),
  };

  return activeUserChatRamCache;
}

export function clearChatRamMemorySingleton(): void {
  if (activeUserChatRamCache) {
    activeUserChatRamCache.threadsByConvId.clear();
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
  if (params.targetSeq <= activeConv.myState.lastReadSeq) {
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
    map.delete(oldestKey);
  }
}
