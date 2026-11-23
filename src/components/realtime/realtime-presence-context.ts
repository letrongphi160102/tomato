import * as React from 'react';

import type { NotificationItemDto } from '@/modules/notifications/notification.service';

export interface DeleteNotificationOutcome {
  readonly ok: boolean;
  readonly errorMessage?: string;
}

export interface RealtimePresenceContextValue {
  readonly notifications: readonly NotificationItemDto[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
  readonly loadingInitial: boolean;
  readonly loadingMore: boolean;
  readonly errorMessage: string | null;
  readonly deletingIds: ReadonlySet<string>;
  readonly activeStatusEnabled: boolean;
  readonly setActiveStatusEnabled: (enabled: boolean) => void;
  readonly refreshNotifications: () => Promise<void>;
  readonly loadMoreNotifications: () => Promise<void>;
  readonly markAsRead: (notificationPublicIds: readonly string[]) => Promise<void>;
  readonly markAllAsRead: () => Promise<void>;
  readonly deleteNotification: (notificationPublicId: string) => Promise<DeleteNotificationOutcome>;
  readonly removeNotificationLocally: (publicId: string) => void;
  readonly disconnectAll: () => void;
}

export const RealtimePresenceContext = React.createContext<RealtimePresenceContextValue | null>(
  null,
);

export function useRealtimePresence(): RealtimePresenceContextValue | null {
  return React.useContext(RealtimePresenceContext);
}
