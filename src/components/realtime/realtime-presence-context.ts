import * as React from 'react';

import type { RealtimeClientEvent } from '@/lib/realtime-client';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

export interface DeleteNotificationOutcome {
  readonly ok: boolean;
  readonly errorMessage?: string;
}

export type ChatRealtimeListener = (event: RealtimeClientEvent) => void;
export type CallRealtimeListener = (event: RealtimeClientEvent) => void;

export interface RealtimePresenceContextValue {
  readonly notifications: readonly NotificationItemDto[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
  readonly loadingInitial: boolean;
  readonly loadingMore: boolean;
  readonly errorMessage: string | null;
  readonly deletingIds: ReadonlySet<string>;
  readonly activeStatusEnabled: boolean;
  readonly readReceiptsEnabled: boolean;
  readonly e2eeReady: boolean;
  readonly setActiveStatusEnabled: (enabled: boolean) => void;
  readonly setReadReceiptsEnabled: (enabled: boolean) => void;
  readonly refreshNotifications: () => Promise<void>;
  readonly loadMoreNotifications: () => Promise<void>;
  readonly markAsRead: (notificationPublicIds: readonly string[]) => Promise<void>;
  readonly markAllAsRead: () => Promise<void>;
  readonly deleteNotification: (notificationPublicId: string) => Promise<DeleteNotificationOutcome>;
  readonly removeNotificationLocally: (publicId: string) => void;
  readonly subscribeChatEvents: (listener: ChatRealtimeListener) => () => void;
  readonly subscribeCallEvents: (listener: CallRealtimeListener) => () => void;
  readonly ensureE2eeDeviceRegistered: () => Promise<boolean>;
  readonly disconnectAll: () => void;
}

export const RealtimePresenceContext = React.createContext<RealtimePresenceContextValue | null>(
  null,
);

export function useRealtimePresence(): RealtimePresenceContextValue | null {
  return React.useContext(RealtimePresenceContext);
}

// ============================================================================
// Bộ nhớ đệm RAM cấp phiên cho Thông báo & Hiện diện (Chỉ lưu trong JS Heap RAM)
// Tuyệt đối không dùng localStorage/sessionStorage — xóa sạch ngay khi đăng xuất.
// ============================================================================

export interface UserRealtimeNotificationRamCache {
  readonly userPublicId: string;
  notifications: readonly NotificationItemDto[];
  unreadCount: number;
  nextCursor: string | null;
  hasLoadedInitial: boolean;
  e2eeReady: boolean;
  lastHeartbeatAtMs: number;
}

let activeUserRealtimeNotificationRamCache: UserRealtimeNotificationRamCache | null = null;

function createEmptyRealtimeNotificationRamCache(
  userPublicId: string,
): UserRealtimeNotificationRamCache {
  return {
    userPublicId,
    notifications: [],
    unreadCount: 0,
    nextCursor: null,
    hasLoadedInitial: false,
    e2eeReady: false,
    lastHeartbeatAtMs: 0,
  };
}

export function getOrInitUserRealtimeNotificationRamCache(
  userPublicId?: string | null,
): UserRealtimeNotificationRamCache {
  const norm = (userPublicId ?? '').trim().toLowerCase();
  if (!norm) {
    return createEmptyRealtimeNotificationRamCache('');
  }
  if (
    activeUserRealtimeNotificationRamCache &&
    activeUserRealtimeNotificationRamCache.userPublicId === norm
  ) {
    return activeUserRealtimeNotificationRamCache;
  }

  activeUserRealtimeNotificationRamCache = createEmptyRealtimeNotificationRamCache(norm);
  return activeUserRealtimeNotificationRamCache;
}

export function clearRealtimeNotificationRamCache(): void {
  if (activeUserRealtimeNotificationRamCache) {
    activeUserRealtimeNotificationRamCache.notifications = [];
    activeUserRealtimeNotificationRamCache.unreadCount = 0;
    activeUserRealtimeNotificationRamCache.nextCursor = null;
    activeUserRealtimeNotificationRamCache.hasLoadedInitial = false;
    activeUserRealtimeNotificationRamCache.e2eeReady = false;
    activeUserRealtimeNotificationRamCache.lastHeartbeatAtMs = 0;
  }
  activeUserRealtimeNotificationRamCache = null;
}
