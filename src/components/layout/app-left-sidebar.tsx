'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, Loader2, LogOut, MessageCircle, Settings } from 'lucide-react';

import { useChatStore } from '@/components/messages/chat-store-context';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { authFetch, clearAccessTokenFreshness } from '@/lib/auth-client';
import { disconnectAllRealtimeConnections } from '@/lib/realtime-client';
import { cn } from '@/lib/utils';

export function AppLeftSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const realtime = useRealtimePresence();
  const chatStore = useChatStore();

  const [loggingOut, setLoggingOut] = React.useState(false);

  const unreadMessagesCount = Math.max(0, chatStore?.unreadConversationsCount ?? 0);
  const unreadMessagesBadgeText = unreadMessagesCount > 99 ? '99+' : String(unreadMessagesCount);

  const isHomeActive = pathname === '/';
  const isMessagesActive = pathname.startsWith('/messages');
  const isSettingsActive = pathname.startsWith('/settings');

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    clearAccessTokenFreshness();
    chatStore?.clearAllChatCache();
    realtime?.disconnectAll();
    disconnectAllRealtimeConnections();
    try {
      await authFetch('/api/v1/auth/logout', { method: 'POST' }, { retryOnUnauthorized: false });
    } finally {
      setLoggingOut(false);
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <>
      {/* Desktop Hover-Expand Sidebar (Zero Layout Shift: giữ khung 72px, mở rộng trượt nổi 232px khi hover với z-30) */}
      <aside
        aria-label="Điều hướng chính"
        onMouseLeave={(event) => {
          if (
            typeof document !== 'undefined' &&
            document.activeElement instanceof HTMLElement &&
            event.currentTarget.contains(document.activeElement)
          ) {
            document.activeElement.blur();
          }
        }}
        className="group fixed left-0 top-14 z-30 hidden h-[calc(100vh-3.5rem)] w-[72px] flex-col justify-between overflow-hidden border-r bg-background/95 px-3 py-4 backdrop-blur transition-[width,box-shadow] duration-200 ease-out hover:w-[232px] hover:shadow-xl md:flex"
      >
        <nav aria-label="Menu điều hướng" className="flex flex-col gap-1.5">
          <Link
            href="/"
            aria-current={isHomeActive ? 'page' : undefined}
            onClick={(event) => event.currentTarget.blur()}
            className={cn(
              'flex h-11 items-center rounded-xl transition-colors',
              isHomeActive
                ? 'bg-primary/10 font-semibold text-primary'
                : 'font-medium text-foreground/85 hover:bg-muted hover:text-foreground',
            )}
          >
            <span className="flex size-12 shrink-0 items-center justify-center">
              <Home className="size-5" aria-hidden="true" />
            </span>
            <span className="truncate pr-3 text-sm whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              Trang chủ
            </span>
          </Link>

          <Link
            href="/messages"
            aria-current={isMessagesActive ? 'page' : undefined}
            onClick={(event) => event.currentTarget.blur()}
            aria-label={
              unreadMessagesCount > 0
                ? `Tin nhắn (${unreadMessagesCount} cuộc trò chuyện chưa đọc)`
                : 'Tin nhắn'
            }
            className={cn(
              'flex h-11 items-center rounded-xl transition-colors',
              isMessagesActive
                ? 'bg-primary/10 font-semibold text-primary'
                : 'font-medium text-foreground/85 hover:bg-muted hover:text-foreground',
            )}
          >
            <span className="relative flex size-12 shrink-0 items-center justify-center">
              <MessageCircle className="size-5" aria-hidden="true" />
              {unreadMessagesCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground shadow-xs ring-2 ring-background"
                >
                  {unreadMessagesBadgeText}
                </span>
              ) : null}
            </span>
            <span className="truncate pr-3 text-sm whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              Tin nhắn
            </span>
          </Link>

          <Link
            href="/settings/privacy"
            aria-current={isSettingsActive ? 'page' : undefined}
            onClick={(event) => event.currentTarget.blur()}
            className={cn(
              'flex h-11 items-center rounded-xl transition-colors',
              isSettingsActive
                ? 'bg-primary/10 font-semibold text-primary'
                : 'font-medium text-foreground/85 hover:bg-muted hover:text-foreground',
            )}
          >
            <span className="flex size-12 shrink-0 items-center justify-center">
              <Settings className="size-5" aria-hidden="true" />
            </span>
            <span className="truncate pr-3 text-sm whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              Cài đặt
            </span>
          </Link>
        </nav>

        <div className="border-t pt-3">
          <button
            type="button"
            disabled={loggingOut}
            onClick={(event) => {
              event.currentTarget.blur();
              void handleLogout();
            }}
            aria-label="Đăng xuất"
            className="flex h-11 w-full items-center rounded-xl font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            <span className="flex size-12 shrink-0 items-center justify-center">
              {loggingOut ? (
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="size-5" aria-hidden="true" />
              )}
            </span>
            <span className="truncate pr-3 text-sm whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              {loggingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile Bottom Navigation Bar (Thân thiện cảm ứng cho màn hình < md) */}
      <nav
        aria-label="Điều hướng di động"
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t bg-background/95 px-2 backdrop-blur md:hidden"
      >
        <Link
          href="/"
          aria-current={isHomeActive ? 'page' : undefined}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors',
            isHomeActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Home className="size-5" aria-hidden="true" />
          <span>Trang chủ</span>
        </Link>

        <Link
          href="/messages"
          aria-current={isMessagesActive ? 'page' : undefined}
          aria-label={
            unreadMessagesCount > 0
              ? `Tin nhắn (${unreadMessagesCount} cuộc trò chuyện chưa đọc)`
              : 'Tin nhắn'
          }
          className={cn(
            'relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors',
            isMessagesActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="relative inline-flex">
            <MessageCircle className="size-5" aria-hidden="true" />
            {unreadMessagesCount > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -right-2.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold leading-none text-destructive-foreground ring-2 ring-background"
              >
                {unreadMessagesBadgeText}
              </span>
            ) : null}
          </span>
          <span>Tin nhắn</span>
        </Link>

        <Link
          href="/settings/privacy"
          aria-current={isSettingsActive ? 'page' : undefined}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors',
            isSettingsActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Settings className="size-5" aria-hidden="true" />
          <span>Cài đặt</span>
        </Link>

        <button
          type="button"
          disabled={loggingOut}
          onClick={() => void handleLogout()}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium text-destructive transition-colors hover:opacity-80 disabled:opacity-50"
        >
          {loggingOut ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="size-5" aria-hidden="true" />
          )}
          <span>Đăng xuất</span>
        </button>
      </nav>
    </>
  );
}
