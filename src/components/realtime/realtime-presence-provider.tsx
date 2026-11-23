'use client';

import * as React from 'react';

import {
  RealtimePresenceContext,
  type RealtimePresenceContextValue,
} from '@/components/realtime/realtime-presence-context';
import { authFetch } from '@/lib/auth-client';
import {
  connectUserRealtime,
  disconnectAllRealtimeConnections,
  type RealtimeClientConnection,
  type RealtimeClientEvent,
} from '@/lib/realtime-client';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

/** Chu kỳ gửi tín hiệu duy trì trạng thái hoạt động từ trình duyệt: 60 giây. */
export const PRESENCE_CLIENT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface RealtimePresenceProviderProps {
  readonly initialShowActiveStatus: boolean;
  readonly children: React.ReactNode;
}

function isNotificationItemDto(value: unknown): value is NotificationItemDto {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<NotificationItemDto>;
  return (
    typeof candidate.public_id === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.actor === 'object' &&
    candidate.actor !== null &&
    typeof candidate.actor.public_id === 'string' &&
    typeof candidate.actor.handle === 'string' &&
    typeof candidate.actor.fullName === 'string'
  );
}

export function RealtimePresenceProvider({
  initialShowActiveStatus,
  children,
}: RealtimePresenceProviderProps) {
  const [notifications, setNotifications] = React.useState<readonly NotificationItemDto[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [activeStatusEnabled, setActiveStatusEnabled] = React.useState(initialShowActiveStatus);

  const connectionRef = React.useRef<RealtimeClientConnection | null>(null);
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const loggedOutRef = React.useRef(false);

  const stopHeartbeatTimer = React.useCallback(() => {
    if (heartbeatIntervalRef.current !== null) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const sendPresenceHeartbeat = React.useCallback(async () => {
    if (
      loggedOutRef.current ||
      typeof document === 'undefined' ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }
    try {
      await authFetch('/api/v1/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      // Bỏ qua lỗi mạng tạm thời; chu kỳ tiếp theo sẽ tự gửi lại.
    }
  }, []);

  const refreshNotifications = React.useCallback(async () => {
    if (loggedOutRef.current) {
      return;
    }
    try {
      const response = await authFetch('/api/v1/notifications?limit=20', {
        method: 'GET',
      });
      if (loggedOutRef.current) {
        return;
      }
      if (!response.ok) {
        setErrorMessage('Không thể tải thông báo lúc này.');
        return;
      }
      const data = (await response.json()) as {
        readonly items?: NotificationItemDto[];
        readonly unreadCount?: number;
        readonly nextCursor?: string | null;
      };
      setErrorMessage(null);
      setNotifications(Array.isArray(data.items) ? data.items : []);
      setUnreadCount(typeof data.unreadCount === 'number' ? Math.max(0, data.unreadCount) : 0);
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch {
      if (!loggedOutRef.current) {
        setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
      }
    } finally {
      if (!loggedOutRef.current) {
        setLoadingInitial(false);
      }
    }
  }, []);

  const loadMoreNotifications = React.useCallback(async () => {
    if (!nextCursor || loadingMore || loggedOutRef.current) {
      return;
    }
    setLoadingMore(true);
    setErrorMessage(null);
    try {
      const params = new URLSearchParams({ limit: '20', cursor: nextCursor });
      const response = await authFetch(`/api/v1/notifications?${params.toString()}`, {
        method: 'GET',
      });
      if (!response.ok) {
        setErrorMessage('Không thể tải thêm thông báo.');
        return;
      }
      const data = (await response.json()) as {
        readonly items?: NotificationItemDto[];
        readonly unreadCount?: number;
        readonly nextCursor?: string | null;
      };
      const incoming = Array.isArray(data.items) ? data.items : [];
      setNotifications((prev) => {
        const seen = new Set(prev.map((item) => item.public_id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.public_id)) {
            seen.add(item.public_id);
            merged.push(item);
          }
        }
        return merged;
      });
      if (typeof data.unreadCount === 'number') {
        setUnreadCount(Math.max(0, data.unreadCount));
      }
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch {
      setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  const markAsRead = React.useCallback(async (notificationPublicIds: readonly string[]) => {
    const uniqueIds = Array.from(new Set(notificationPublicIds));
    if (uniqueIds.length === 0 || loggedOutRef.current) {
      return;
    }

    const nowIso = new Date().toISOString();
    const idSet = new Set(uniqueIds);

    setNotifications((prev) => {
      let newlyReadCount = 0;
      const updated = prev.map((item) => {
        if (idSet.has(item.public_id) && item.readAt === null) {
          newlyReadCount += 1;
          return { ...item, readAt: nowIso };
        }
        return item;
      });
      if (newlyReadCount > 0) {
        setUnreadCount((count) => Math.max(0, count - newlyReadCount));
      }
      return updated;
    });

    try {
      const response = await authFetch('/api/v1/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationPublicIds: uniqueIds }),
      });
      if (response.ok) {
        const data = (await response.json()) as { readonly unreadCount?: number };
        if (typeof data.unreadCount === 'number') {
          setUnreadCount(Math.max(0, data.unreadCount));
        }
      }
    } catch {
      // Giữ trạng thái cục bộ và sẽ tự đồng bộ ở lần tải tiếp theo.
    }
  }, []);

  const markAllAsRead = React.useCallback(async () => {
    if (loggedOutRef.current) {
      return;
    }
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((item) => (item.readAt === null ? { ...item, readAt: nowIso } : item)),
    );
    setUnreadCount(0);

    try {
      const response = await authFetch('/api/v1/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markAll: true }),
      });
      if (response.ok) {
        const data = (await response.json()) as { readonly unreadCount?: number };
        if (typeof data.unreadCount === 'number') {
          setUnreadCount(Math.max(0, data.unreadCount));
        }
      }
    } catch {
      // Đồng bộ lại khi tab active hoặc mở lại bảng thông báo.
    }
  }, []);

  const removeNotificationLocally = React.useCallback((publicId: string) => {
    setNotifications((prev) => {
      const target = prev.find((item) => item.public_id === publicId);
      if (target && target.readAt === null) {
        setUnreadCount((count) => Math.max(0, count - 1));
      }
      return prev.filter((item) => item.public_id !== publicId);
    });
  }, []);

  const handleRealtimeEvent = React.useCallback((incoming: RealtimeClientEvent) => {
    if (loggedOutRef.current) {
      return;
    }

    if (incoming.event === 'notification.created') {
      const maybeNotification = incoming.data.notification;
      if (isNotificationItemDto(maybeNotification)) {
        setNotifications((prev) => {
          const withoutDuplicate = prev.filter(
            (item) => item.public_id !== maybeNotification.public_id,
          );
          return [maybeNotification, ...withoutDuplicate];
        });
      }
      if (typeof incoming.data.unreadCount === 'number') {
        setUnreadCount(Math.max(0, incoming.data.unreadCount));
      }
      return;
    }

    if (incoming.event === 'notification.read') {
      const markAll = incoming.data.markAll === true;
      const readIds = Array.isArray(incoming.data.notificationPublicIds)
        ? new Set(
            incoming.data.notificationPublicIds.filter(
              (id): id is string => typeof id === 'string',
            ),
          )
        : new Set<string>();
      const nowIso = new Date().toISOString();

      setNotifications((prev) =>
        prev.map((item) => {
          if (item.readAt !== null) {
            return item;
          }
          if (markAll || readIds.has(item.public_id)) {
            return { ...item, readAt: nowIso };
          }
          return item;
        }),
      );
      if (typeof incoming.data.unreadCount === 'number') {
        setUnreadCount(Math.max(0, incoming.data.unreadCount));
      }
      return;
    }

    if (incoming.event === 'notification.removed') {
      const removedIds = Array.isArray(incoming.data.notificationPublicIds)
        ? new Set(
            incoming.data.notificationPublicIds.filter(
              (id): id is string => typeof id === 'string',
            ),
          )
        : new Set<string>();

      if (removedIds.size > 0) {
        setNotifications((prev) => prev.filter((item) => !removedIds.has(item.public_id)));
      }
      if (typeof incoming.data.unreadCount === 'number') {
        setUnreadCount(Math.max(0, incoming.data.unreadCount));
      }
    }
  }, []);

  const disconnectAll = React.useCallback(() => {
    loggedOutRef.current = true;
    stopHeartbeatTimer();
    if (connectionRef.current) {
      connectionRef.current.disconnect();
      connectionRef.current = null;
    }
    disconnectAllRealtimeConnections();
  }, [stopHeartbeatTimer]);

  // Nạp danh sách thông báo ban đầu và thiết lập kênh nhận thông báo trực tiếp.
  React.useEffect(() => {
    loggedOutRef.current = false;
    const controller = new AbortController();

    void authFetch('/api/v1/notifications?limit=20', {
      method: 'GET',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted || loggedOutRef.current) {
          return;
        }
        if (!response.ok) {
          setErrorMessage('Không thể tải thông báo lúc này.');
          return;
        }
        const data = (await response.json()) as {
          readonly items?: NotificationItemDto[];
          readonly unreadCount?: number;
          readonly nextCursor?: string | null;
        };
        setErrorMessage(null);
        setNotifications(Array.isArray(data.items) ? data.items : []);
        setUnreadCount(typeof data.unreadCount === 'number' ? Math.max(0, data.unreadCount) : 0);
        setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      })
      .catch(() => {
        if (!controller.signal.aborted && !loggedOutRef.current) {
          setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && !loggedOutRef.current) {
          setLoadingInitial(false);
        }
      });

    const connection = connectUserRealtime({
      onEvent: handleRealtimeEvent,
    });
    connectionRef.current = connection;

    return () => {
      controller.abort();
      connection.disconnect();
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
    };
  }, [handleRealtimeEvent]);

  // Duy trì nhịp cập nhật trạng thái hoạt động mỗi 60 giây khi tab đang mở và người dùng đang bật tính năng.
  React.useEffect(() => {
    stopHeartbeatTimer();
    if (!activeStatusEnabled || loggedOutRef.current) {
      return;
    }

    const startOrStopForVisibility = () => {
      stopHeartbeatTimer();
      if (loggedOutRef.current || document.visibilityState !== 'visible') {
        return;
      }
      void sendPresenceHeartbeat();
      heartbeatIntervalRef.current = setInterval(() => {
        void sendPresenceHeartbeat();
      }, PRESENCE_CLIENT_HEARTBEAT_INTERVAL_MS);
    };

    startOrStopForVisibility();
    document.addEventListener('visibilitychange', startOrStopForVisibility);

    return () => {
      document.removeEventListener('visibilitychange', startOrStopForVisibility);
      stopHeartbeatTimer();
    };
  }, [activeStatusEnabled, sendPresenceHeartbeat, stopHeartbeatTimer]);

  // Tự đồng bộ lại thông báo khi người dùng quay lại tab sau một khoảng thời gian ẩn.
  React.useEffect(() => {
    const handleVisibilityRefresh = () => {
      if (!loggedOutRef.current && document.visibilityState === 'visible') {
        void refreshNotifications();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityRefresh);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityRefresh);
    };
  }, [refreshNotifications]);

  const contextValue = React.useMemo<RealtimePresenceContextValue>(
    () => ({
      notifications,
      unreadCount,
      nextCursor,
      loadingInitial,
      loadingMore,
      errorMessage,
      activeStatusEnabled,
      setActiveStatusEnabled,
      refreshNotifications,
      loadMoreNotifications,
      markAsRead,
      markAllAsRead,
      removeNotificationLocally,
      disconnectAll,
    }),
    [
      activeStatusEnabled,
      disconnectAll,
      errorMessage,
      loadMoreNotifications,
      loadingInitial,
      loadingMore,
      markAllAsRead,
      markAsRead,
      nextCursor,
      notifications,
      refreshNotifications,
      removeNotificationLocally,
      unreadCount,
    ],
  );

  return (
    <RealtimePresenceContext.Provider value={contextValue}>
      {children}
    </RealtimePresenceContext.Provider>
  );
}
