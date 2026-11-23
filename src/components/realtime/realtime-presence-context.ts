import * as React from 'react';

import type { RealtimeClientEvent } from '@/lib/realtime-client';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

export interface DeleteNotificationOutcome {
  readonly ok: boolean;
  readonly errorMessage?: string;
}

export type ChatRealtimeListener = (event: RealtimeClientEvent) => void;

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
  readonly ensureE2eeDeviceRegistered: () => Promise<boolean>;
  readonly disconnectAll: () => void;
}

export const RealtimePresenceContext = React.createContext<RealtimePresenceContextValue | null>(
  null,
);

export function useRealtimePresence(): RealtimePresenceContextValue | null {
  return React.useContext(RealtimePresenceContext);
}
