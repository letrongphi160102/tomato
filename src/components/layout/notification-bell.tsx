'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, Check, Loader2, MoreHorizontal, Trash2 } from 'lucide-react';

import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authFetch } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import type { NotificationItemDto } from '@/modules/notifications/notification.service';

function formatRelativeTimeVi(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) {
    return 'Vừa xong';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} phút trước`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} giờ trước`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} ngày trước`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${diffMonths} tháng trước`;
  }
  return `${Math.floor(diffMonths / 12)} năm trước`;
}

function getNotificationActionText(type: NotificationItemDto['type']): string {
  switch (type) {
    case 'follow_request':
      return 'đã yêu cầu theo dõi bạn';
    case 'follow_accepted':
      return 'đã chấp nhận yêu cầu theo dõi của bạn';
    case 'new_follower':
      return 'đã bắt đầu theo dõi bạn';
    case 'message_request':
      return 'muốn gửi tin nhắn cho bạn';
  }
}

export function NotificationBell() {
  const router = useRouter();
  const realtime = useRealtimePresence();

  const [open, setOpen] = React.useState(false);
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null);
  const [busyActorIds, setBusyActorIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-notification-menu-content="true"]')
      ) {
        return;
      }
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpenMenuId(null);
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (openMenuId !== null) {
          return;
        }
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, openMenuId]);

  if (!realtime) {
    return null;
  }

  const {
    notifications,
    unreadCount,
    nextCursor,
    loadingInitial,
    loadingMore,
    errorMessage,
    deletingIds,
    refreshNotifications,
    loadMoreNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    removeNotificationLocally,
  } = realtime;

  const badgeText = unreadCount > 99 ? '99+' : String(unreadCount);

  function handleToggleDropdown() {
    setActionError(null);
    setOpenMenuId(null);
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        void refreshNotifications();
      }
      return next;
    });
  }

  async function handleDeleteNotification(notificationPublicId: string) {
    setOpenMenuId(null);
    setActionError(null);
    const outcome = await deleteNotification(notificationPublicId);
    if (!outcome.ok && outcome.errorMessage) {
      setActionError(outcome.errorMessage);
    }
  }

  async function handleFollowRequestDecision(
    notification: NotificationItemDto,
    action: 'accept' | 'decline',
  ) {
    const actorPublicId = notification.actor.public_id;
    if (busyActorIds.has(actorPublicId)) {
      return;
    }
    setBusyActorIds((prev) => new Set(prev).add(actorPublicId));
    setActionError(null);

    try {
      const response = await authFetch(
        `/api/v1/social/follow-requests/${encodeURIComponent(actorPublicId)}/${action}`,
        { method: 'POST' },
      );

      if (!response.ok) {
        if (response.status === 404) {
          removeNotificationLocally(notification.public_id);
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          readonly error?: { readonly message?: string };
        } | null;
        setActionError(body?.error?.message ?? 'Không thể xử lý yêu cầu lúc này.');
        return;
      }

      removeNotificationLocally(notification.public_id);
      router.refresh();
    } catch {
      setActionError('Không thể kết nối. Vui lòng thử lại.');
    } finally {
      setBusyActorIds((prev) => {
        const next = new Set(prev);
        next.delete(actorPublicId);
        return next;
      });
    }
  }

  function handleItemNavigate(item: NotificationItemDto) {
    if (item.readAt === null) {
      void markAsRead([item.public_id]);
    }
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Thông báo (${unreadCount} chưa đọc)` : 'Thông báo'}
        onClick={handleToggleDropdown}
        className="relative size-9 rounded-full"
      >
        <Bell className="size-4" aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground shadow-sm ring-2 ring-background"
          >
            {badgeText}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-label="Danh sách thông báo"
          className="fixed inset-x-3 top-16 z-50 flex max-h-[75vh] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[390px]"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Thông báo</h2>
              {unreadCount > 0 ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                  {badgeText}
                </span>
              ) : null}
            </div>

            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={() => void markAllAsRead()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Check className="size-3.5" aria-hidden="true" />
                <span>Đánh dấu tất cả là đã đọc</span>
              </button>
            ) : null}
          </div>

          <div className="flex-1 overflow-y-auto">
            {actionError || errorMessage ? (
              <p
                role="alert"
                className="border-b bg-destructive/5 px-4 py-2 text-xs font-medium text-destructive"
              >
                {actionError ?? errorMessage}
              </p>
            ) : null}

            {loadingInitial ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                <span>Đang tải thông báo...</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Bell className="size-5" aria-hidden="true" />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">Chưa có thông báo nào.</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Khi có người theo dõi hoặc tương tác với bạn, thông báo sẽ hiển thị tại đây.
                </p>
              </div>
            ) : (
              <ul className="divide-y">
                {notifications.map((item) => {
                  const isUnread = item.readAt === null;
                  const isFollowRequest =
                    item.type === 'follow_request' && item.followRequestPending;
                  const isBusy = busyActorIds.has(item.actor.public_id);
                  const isDeleting = deletingIds.has(item.public_id);
                  const isMenuOpen = openMenuId === item.public_id;
                  const actorHref = `/u/${encodeURIComponent(item.actor.handle)}`;
                  const primaryHref =
                    item.type === 'message_request'
                      ? item.entityPublicId
                        ? `/messages?tab=pending&conversation=${encodeURIComponent(item.entityPublicId)}`
                        : '/messages?tab=pending'
                      : actorHref;

                  return (
                    <li
                      key={item.public_id}
                      className={cn(
                        'group px-4 py-3 transition-all duration-150 ease-out hover:bg-muted/40',
                        isUnread ? 'bg-primary/[0.04]' : null,
                        isDeleting ? 'pointer-events-none -translate-x-2 opacity-0' : null,
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <Link
                          href={primaryHref}
                          onClick={() => handleItemNavigate(item)}
                          className="shrink-0"
                        >
                          <UserAvatar
                            fullName={item.actor.fullName}
                            avatarUrl={item.actor.avatarUrl}
                            size="sm"
                          />
                        </Link>

                        <div className="min-w-0 flex-1">
                          <Link
                            href={primaryHref}
                            onClick={() => handleItemNavigate(item)}
                            className="block text-sm leading-snug text-foreground"
                          >
                            <span className="font-semibold">{item.actor.fullName}</span>{' '}
                            <span className="text-foreground/85">
                              {getNotificationActionText(item.type)}
                            </span>
                          </Link>

                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>@{item.actor.handle}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatRelativeTimeVi(item.createdAt)}</span>
                          </div>

                          {isFollowRequest ? (
                            <div className="mt-2.5 flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={isBusy || isDeleting}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleFollowRequestDecision(item, 'accept');
                                }}
                                className="h-7 rounded-lg px-3 text-xs"
                              >
                                {isBusy ? (
                                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                                ) : (
                                  <span>Chấp nhận</span>
                                )}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={isBusy || isDeleting}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleFollowRequestDecision(item, 'decline');
                                }}
                                className="h-7 rounded-lg px-3 text-xs"
                              >
                                Từ chối
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {isUnread ? (
                            <span
                              aria-label="Chưa đọc"
                              className="size-2 shrink-0 rounded-full bg-primary"
                            />
                          ) : null}

                          <DropdownMenu
                            modal={false}
                            open={isMenuOpen}
                            onOpenChange={(nextOpen) =>
                              setOpenMenuId(nextOpen ? item.public_id : null)
                            }
                          >
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={isDeleting}
                                aria-label={`Tùy chọn thông báo từ ${item.actor.fullName}`}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                className={cn(
                                  'size-8 rounded-full text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground',
                                  'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
                                  isMenuOpen ? 'sm:opacity-100' : null,
                                )}
                              >
                                <MoreHorizontal className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>

                            <DropdownMenuContent
                              align="end"
                              data-notification-menu-content="true"
                              onClick={(event) => event.stopPropagation()}
                              className="w-56"
                            >
                              <DropdownMenuItem
                                disabled={isDeleting}
                                onSelect={(event) => {
                                  event.stopPropagation();
                                  void handleDeleteNotification(item.public_id);
                                }}
                                className="items-start text-destructive focus:bg-destructive/10 focus:text-destructive"
                              >
                                <Trash2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                                <div className="flex flex-col">
                                  <span className="font-medium leading-tight">
                                    Xóa thông báo này
                                  </span>
                                  {isFollowRequest ? (
                                    <span className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                                      Không từ chối yêu cầu theo dõi
                                    </span>
                                  ) : null}
                                </div>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {nextCursor && !loadingInitial ? (
              <div className="border-t py-2.5 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void loadMoreNotifications()}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      <span>Đang tải thêm...</span>
                    </>
                  ) : (
                    <span>Xem thêm</span>
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
