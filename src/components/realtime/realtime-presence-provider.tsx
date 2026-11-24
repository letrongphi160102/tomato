'use client';

import * as React from 'react';

import { clearChatRamMemorySingleton } from '@/components/messages/chat-store-context';
import {
  clearRealtimeNotificationRamCache,
  getOrInitUserRealtimeNotificationRamCache,
  RealtimePresenceContext,
  type CallRealtimeListener,
  type ChatRealtimeListener,
  type DeleteNotificationOutcome,
  type RealtimePresenceContextValue,
} from '@/components/realtime/realtime-presence-context';
import { authFetch, seedAccessTokenFreshness } from '@/lib/auth-client';
import {
  clearE2eeClientBootstrapState,
  ensureE2eeDeviceRegisteredSingleton,
} from '@/lib/e2ee/client-bootstrap';
import {
  connectUserRealtime,
  disconnectAllRealtimeConnections,
  type RealtimeClientConnection,
  type RealtimeClientEvent,
} from '@/lib/realtime-client';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

/** Chu kỳ gửi tín hiệu duy trì trạng thái hoạt động từ trình duyệt: 60 giây. */
export const PRESENCE_CLIENT_HEARTBEAT_INTERVAL_MS = 60_000;
/** Khoảng cách tối thiểu giữa 2 lần gửi heartbeat khi điều hướng qua lại giữa `/` và Dashboard. */
const PRESENCE_CLIENT_HEARTBEAT_MIN_GAP_MS = 30_000;

export interface RealtimePresenceProviderProps {
  readonly currentUserPublicId?: string;
  readonly initialShowActiveStatus: boolean;
  readonly initialShowReadReceipts?: boolean;
  readonly initialAccessTokenRemainingMs?: number;
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
  currentUserPublicId,
  initialShowActiveStatus,
  initialShowReadReceipts = true,
  initialAccessTokenRemainingMs,
  children,
}: RealtimePresenceProviderProps) {
  const [notifications, setNotificationsState] = React.useState<readonly NotificationItemDto[]>(
    () => getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).notifications,
  );
  const [unreadCount, setUnreadCountState] = React.useState<number>(
    () => getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).unreadCount,
  );
  const [nextCursor, setNextCursorState] = React.useState<string | null>(
    () => getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).nextCursor,
  );
  const [loadingInitial, setLoadingInitialState] = React.useState<boolean>(
    () => !getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).hasLoadedInitial,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [deletingIds, setDeletingIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [activeStatusEnabled, setActiveStatusEnabled] = React.useState(initialShowActiveStatus);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = React.useState(initialShowReadReceipts);
  const [e2eeReady, setE2eeReadyState] = React.useState<boolean>(
    () => getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).e2eeReady,
  );

  const notificationsRef = React.useRef<readonly NotificationItemDto[]>(notifications);
  const deletingIdsRef = React.useRef<Set<string>>(new Set());
  const inFlightUnreadDeleteIdsRef = React.useRef<Set<string>>(new Set());
  const exitTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const chatListenersRef = React.useRef<Set<ChatRealtimeListener>>(new Set());
  const callListenersRef = React.useRef<Set<CallRealtimeListener>>(new Set());
  const connectionRef = React.useRef<RealtimeClientConnection | null>(null);
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const loggedOutRef = React.useRef(false);

  const setNotifications = React.useCallback(
    (
      updater:
        | readonly NotificationItemDto[]
        | ((prev: readonly NotificationItemDto[]) => readonly NotificationItemDto[]),
    ) => {
      setNotificationsState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (!loggedOutRef.current && currentUserPublicId) {
          getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).notifications = next;
        }
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setUnreadCount = React.useCallback(
    (updater: number | ((prev: number) => number)) => {
      setUnreadCountState((prev) => {
        const rawNext = typeof updater === 'function' ? updater(prev) : updater;
        const next = Math.max(0, rawNext);
        if (!loggedOutRef.current && currentUserPublicId) {
          getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).unreadCount = next;
        }
        return next;
      });
    },
    [currentUserPublicId],
  );

  const setNextCursor = React.useCallback(
    (cursor: string | null) => {
      setNextCursorState(cursor);
      if (!loggedOutRef.current && currentUserPublicId) {
        getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).nextCursor = cursor;
      }
    },
    [currentUserPublicId],
  );

  const markInitialNotificationsLoaded = React.useCallback(() => {
    setLoadingInitialState(false);
    if (!loggedOutRef.current && currentUserPublicId) {
      getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).hasLoadedInitial = true;
    }
  }, [currentUserPublicId]);

  const setE2eeReady = React.useCallback(
    (ready: boolean) => {
      setE2eeReadyState(ready);
      if (!loggedOutRef.current && currentUserPublicId) {
        getOrInitUserRealtimeNotificationRamCache(currentUserPublicId).e2eeReady = ready;
      }
    },
    [currentUserPublicId],
  );

  React.useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

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
    const nowMs = Date.now();
    if (currentUserPublicId) {
      const cache = getOrInitUserRealtimeNotificationRamCache(currentUserPublicId);
      if (nowMs - cache.lastHeartbeatAtMs < PRESENCE_CLIENT_HEARTBEAT_MIN_GAP_MS) {
        return;
      }
      cache.lastHeartbeatAtMs = nowMs;
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
  }, [currentUserPublicId]);

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
      markInitialNotificationsLoaded();
    } catch {
      if (!loggedOutRef.current) {
        setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
      }
    } finally {
      if (!loggedOutRef.current) {
        setLoadingInitialState(false);
      }
    }
  }, [markInitialNotificationsLoaded, setNextCursor, setNotifications, setUnreadCount]);

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
  }, [loadingMore, nextCursor, setNextCursor, setNotifications, setUnreadCount]);

  const markAsRead = React.useCallback(
    async (notificationPublicIds: readonly string[]) => {
      const uniqueIds = Array.from(new Set(notificationPublicIds));
      if (uniqueIds.length === 0 || loggedOutRef.current) {
        return;
      }

      const nowIso = new Date().toISOString();
      const idSet = new Set(uniqueIds);
      const newlyReadCount = notificationsRef.current.reduce(
        (acc, item) => (idSet.has(item.public_id) && item.readAt === null ? acc + 1 : acc),
        0,
      );

      setNotifications((prev) =>
        prev.map((item) =>
          idSet.has(item.public_id) && item.readAt === null ? { ...item, readAt: nowIso } : item,
        ),
      );
      if (newlyReadCount > 0) {
        setUnreadCount((count) => Math.max(0, count - newlyReadCount));
      }

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
    },
    [setNotifications, setUnreadCount],
  );

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
  }, [setNotifications, setUnreadCount]);

  const removeNotificationLocally = React.useCallback(
    (publicId: string) => {
      const target = notificationsRef.current.find((item) => item.public_id === publicId);
      setNotifications((prev) => prev.filter((item) => item.public_id !== publicId));
      if (target && target.readAt === null) {
        setUnreadCount((count) => Math.max(0, count - 1));
      }
    },
    [setNotifications, setUnreadCount],
  );

  /**
   * Xóa 1 thông báo với Optimistic UI an toàn khi xóa nhanh nhiều dòng song song:
   * - Chặn gửi trùng trên cùng `public_id` bằng `deletingIdsRef`.
   * - Chỉ rollback đúng dòng bị lỗi (không ghi đè snapshot toàn mảng làm hỏng các dòng khác đang xóa).
   */
  const deleteNotification = React.useCallback(
    async (notificationPublicId: string): Promise<DeleteNotificationOutcome> => {
      if (loggedOutRef.current || deletingIdsRef.current.has(notificationPublicId)) {
        return { ok: true };
      }

      const currentItems = notificationsRef.current;
      const originalIndex = currentItems.findIndex(
        (item) => item.public_id === notificationPublicId,
      );
      if (originalIndex === -1) {
        return { ok: true };
      }

      const targetItem = currentItems[originalIndex];
      if (!targetItem) {
        return { ok: true };
      }

      const wasUnread = targetItem.readAt === null;

      deletingIdsRef.current.add(notificationPublicId);
      setDeletingIds(new Set(deletingIdsRef.current));

      if (wasUnread) {
        inFlightUnreadDeleteIdsRef.current.add(notificationPublicId);
        setUnreadCount((count) => Math.max(0, count - 1));
      }

      let removedFromList = false;
      let abortedForRollback = false;

      const clearExitTimer = () => {
        const existingTimer = exitTimersRef.current.get(notificationPublicId);
        if (existingTimer !== undefined) {
          clearTimeout(existingTimer);
          exitTimersRef.current.delete(notificationPublicId);
        }
      };

      const removeNow = () => {
        clearExitTimer();
        if (removedFromList || abortedForRollback) {
          return;
        }
        removedFromList = true;
        setNotifications((prev) => prev.filter((item) => item.public_id !== notificationPublicId));
      };

      const exitTimer = setTimeout(removeNow, 150);
      exitTimersRef.current.set(notificationPublicId, exitTimer);

      const rollbackItemOnly = (message: string): DeleteNotificationOutcome => {
        abortedForRollback = true;
        clearExitTimer();
        deletingIdsRef.current.delete(notificationPublicId);
        setDeletingIds(new Set(deletingIdsRef.current));

        if (removedFromList) {
          setNotifications((prev) => {
            if (prev.some((item) => item.public_id === targetItem.public_id)) {
              return prev;
            }
            const next = [...prev];
            const insertAt = Math.min(originalIndex, next.length);
            next.splice(insertAt, 0, targetItem);
            return next;
          });
        }

        if (wasUnread && inFlightUnreadDeleteIdsRef.current.delete(notificationPublicId)) {
          setUnreadCount((count) => count + 1);
        }

        return { ok: false, errorMessage: message };
      };

      try {
        const response = await authFetch(
          `/api/v1/notifications/${encodeURIComponent(notificationPublicId)}`,
          { method: 'DELETE' },
        );

        if (loggedOutRef.current) {
          clearExitTimer();
          return { ok: true };
        }

        if (response.status === 404) {
          // Thông báo đã bị xóa ở tab/thiết bị khác -> giữ trạng thái đã gỡ sạch sẽ.
          inFlightUnreadDeleteIdsRef.current.delete(notificationPublicId);
          deletingIdsRef.current.delete(notificationPublicId);
          setDeletingIds(new Set(deletingIdsRef.current));
          removeNow();
          return { ok: true };
        }

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          return rollbackItemOnly(
            body?.error?.message ?? 'Không thể xóa thông báo lúc này. Vui lòng thử lại.',
          );
        }

        const data = (await response.json().catch(() => null)) as {
          readonly unreadCount?: number;
        } | null;

        inFlightUnreadDeleteIdsRef.current.delete(notificationPublicId);
        deletingIdsRef.current.delete(notificationPublicId);
        setDeletingIds(new Set(deletingIdsRef.current));
        removeNow();

        if (typeof data?.unreadCount === 'number') {
          setUnreadCount(Math.max(0, data.unreadCount - inFlightUnreadDeleteIdsRef.current.size));
        }

        return { ok: true };
      } catch {
        if (loggedOutRef.current) {
          clearExitTimer();
          return { ok: true };
        }
        return rollbackItemOnly('Không thể kết nối. Vui lòng thử lại.');
      }
    },
    [setNotifications, setUnreadCount],
  );

  const handleRealtimeEvent = React.useCallback(
    (incoming: RealtimeClientEvent) => {
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
          setUnreadCount(
            Math.max(0, incoming.data.unreadCount - inFlightUnreadDeleteIdsRef.current.size),
          );
        }
        return;
      }

      if (incoming.event === 'notification.deleted') {
        const deletedId =
          typeof incoming.data.notificationPublicId === 'string'
            ? incoming.data.notificationPublicId
            : null;

        if (deletedId) {
          const timer = exitTimersRef.current.get(deletedId);
          if (timer !== undefined) {
            clearTimeout(timer);
            exitTimersRef.current.delete(deletedId);
          }
          setNotifications((prev) => prev.filter((item) => item.public_id !== deletedId));
        }
        if (typeof incoming.data.unreadCount === 'number') {
          setUnreadCount(
            Math.max(0, incoming.data.unreadCount - inFlightUnreadDeleteIdsRef.current.size),
          );
        }
        return;
      }

      if (
        incoming.event === 'chat.message.created' ||
        incoming.event === 'chat.message.updated' ||
        incoming.event === 'chat.message.recalled' ||
        incoming.event === 'chat.message.deleted_for_me' ||
        incoming.event === 'chat.message.reaction.updated' ||
        incoming.event === 'chat.message.pin.updated' ||
        incoming.event === 'chat.conversation.read' ||
        incoming.event === 'chat.conversation.updated' ||
        incoming.event === 'chat.conversation.preferences.updated' ||
        incoming.event === 'chat.conversation.deleted'
      ) {
        for (const listener of Array.from(chatListenersRef.current)) {
          try {
            listener(incoming);
          } catch {
            // Không để lỗi ở 1 subscriber ảnh hưởng tới subscriber khác.
          }
        }
        return;
      }

      if (
        incoming.event === 'call.incoming' ||
        incoming.event === 'call.accepted' ||
        incoming.event === 'call.declined' ||
        incoming.event === 'call.ended' ||
        incoming.event === 'call.signal'
      ) {
        for (const listener of Array.from(callListenersRef.current)) {
          try {
            listener(incoming);
          } catch {
            // Cô lập lỗi của từng subscriber sự kiện cuộc gọi.
          }
        }
      }
    },
    [setNotifications, setUnreadCount],
  );

  const subscribeChatEvents = React.useCallback((listener: ChatRealtimeListener) => {
    chatListenersRef.current.add(listener);
    return () => {
      chatListenersRef.current.delete(listener);
    };
  }, []);

  const subscribeCallEvents = React.useCallback((listener: CallRealtimeListener) => {
    callListenersRef.current.add(listener);
    return () => {
      callListenersRef.current.delete(listener);
    };
  }, []);

  const ensureE2eeDeviceRegistered = React.useCallback(async (): Promise<boolean> => {
    if (!currentUserPublicId || loggedOutRef.current) {
      return false;
    }
    const ok = await ensureE2eeDeviceRegisteredSingleton(currentUserPublicId);
    if (ok && !loggedOutRef.current) {
      setE2eeReady(true);
    }
    return ok;
  }, [currentUserPublicId, setE2eeReady]);

  const disconnectAll = React.useCallback(() => {
    loggedOutRef.current = true;
    stopHeartbeatTimer();
    clearChatRamMemorySingleton();
    clearRealtimeNotificationRamCache();
    clearE2eeClientBootstrapState();
    for (const timer of exitTimersRef.current.values()) {
      clearTimeout(timer);
    }
    exitTimersRef.current.clear();
    if (connectionRef.current) {
      connectionRef.current.disconnect();
      connectionRef.current = null;
    }
    disconnectAllRealtimeConnections();
  }, [stopHeartbeatTimer]);

  // Khởi tạo mốc hết hạn Access Token từ SSR TRƯỚC các effect gọi API để làm mới chủ động không phát sinh 401.
  React.useEffect(() => {
    if (typeof initialAccessTokenRemainingMs === 'number') {
      seedAccessTokenFreshness(initialAccessTokenRemainingMs);
    }
  }, [initialAccessTokenRemainingMs]);

  // Tự động khởi tạo & đăng ký khóa thiết bị ngay khi người dùng đăng nhập vào Dashboard.
  React.useEffect(() => {
    if (!currentUserPublicId || loggedOutRef.current) {
      return;
    }
    void ensureE2eeDeviceRegistered();
  }, [currentUserPublicId, ensureE2eeDeviceRegistered]);

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
        markInitialNotificationsLoaded();
      })
      .catch(() => {
        if (!controller.signal.aborted && !loggedOutRef.current) {
          setErrorMessage('Không thể kết nối. Vui lòng thử lại.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && !loggedOutRef.current) {
          setLoadingInitialState(false);
        }
      });

    const connection = connectUserRealtime({
      userPublicId: currentUserPublicId,
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
  }, [
    currentUserPublicId,
    handleRealtimeEvent,
    markInitialNotificationsLoaded,
    setNextCursor,
    setNotifications,
    setUnreadCount,
  ]);

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
      deletingIds,
      activeStatusEnabled,
      readReceiptsEnabled,
      e2eeReady,
      setActiveStatusEnabled,
      setReadReceiptsEnabled,
      refreshNotifications,
      loadMoreNotifications,
      markAsRead,
      markAllAsRead,
      deleteNotification,
      removeNotificationLocally,
      subscribeChatEvents,
      subscribeCallEvents,
      ensureE2eeDeviceRegistered,
      disconnectAll,
    }),
    [
      activeStatusEnabled,
      deleteNotification,
      deletingIds,
      disconnectAll,
      e2eeReady,
      ensureE2eeDeviceRegistered,
      errorMessage,
      loadMoreNotifications,
      loadingInitial,
      loadingMore,
      markAllAsRead,
      markAsRead,
      nextCursor,
      notifications,
      readReceiptsEnabled,
      refreshNotifications,
      removeNotificationLocally,
      subscribeCallEvents,
      subscribeChatEvents,
      unreadCount,
    ],
  );

  return (
    <RealtimePresenceContext.Provider value={contextValue}>
      {children}
    </RealtimePresenceContext.Provider>
  );
}
