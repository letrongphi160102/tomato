'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronDown,
  Home,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MonitorSmartphone,
  Pencil,
  Search,
  Settings,
  User,
  UserCircle2,
  X,
} from 'lucide-react';

import { TomatoLogo } from '@/components/brand/tomato-logo';
import { NotificationBell } from '@/components/layout/notification-bell';
import { UserSearchBar } from '@/components/layout/user-search-bar';
import { UserAvatar } from '@/components/profile/user-avatar';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import { Button } from '@/components/ui/button';
import { authFetch, clearAccessTokenFreshness } from '@/lib/auth-client';
import { disconnectAllRealtimeConnections } from '@/lib/realtime-client';
import { cn } from '@/lib/utils';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AppTopBarProps {
  readonly user: PublicUserProfile;
  readonly avatarUrl?: string | null;
  readonly handle?: string;
}

export function AppTopBar({ user, avatarUrl = null, handle }: AppTopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const realtime = useRealtimePresence();

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const menuContainerRef = React.useRef<HTMLDivElement | null>(null);

  const effectiveHandle = handle ?? user.username;
  const profilePath = `/u/${encodeURIComponent(effectiveHandle)}`;

  React.useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        menuContainerRef.current &&
        event.target instanceof Node &&
        !menuContainerRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    // Đóng kết nối Realtime (Ably/EventSource), xóa mốc Access Token và dừng heartbeat ngay lập tức khi đăng xuất.
    clearAccessTokenFreshness();
    realtime?.disconnectAll();
    disconnectAllRealtimeConnections();
    try {
      await authFetch('/api/v1/auth/logout', { method: 'POST' }, { retryOnUnauthorized: false });
    } finally {
      setMenuOpen(false);
      setLoggingOut(false);
      router.replace('/login');
      router.refresh();
    }
  }

  const isHomeActive = pathname === '/';
  const isOwnProfileActive = pathname === profilePath;
  const isSettingsActive = pathname.startsWith('/settings');

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-4 lg:gap-6">
          <Link
            href="/"
            aria-label="Trang chủ Tomato"
            className="inline-flex shrink-0 items-center rounded-md px-1 py-1 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TomatoLogo size="sm" priority />
          </Link>

          <nav aria-label="Điều hướng chính" className="hidden items-center gap-1 md:flex">
            <Link
              href="/"
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isHomeActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Home className="size-4" aria-hidden="true" />
              <span>Trang chủ</span>
            </Link>

            <Link
              href={profilePath}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isOwnProfileActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <UserCircle2 className="size-4" aria-hidden="true" />
              <span>Trang cá nhân</span>
            </Link>

            <Link
              href="/settings/profile"
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isSettingsActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Settings className="size-4" aria-hidden="true" />
              <span>Cài đặt</span>
            </Link>
          </nav>
        </div>

        <div className="hidden flex-1 justify-center px-2 sm:flex">
          <UserSearchBar />
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={mobileSearchOpen ? 'Đóng tìm kiếm' : 'Mở tìm kiếm người dùng'}
            aria-expanded={mobileSearchOpen}
            onClick={() => setMobileSearchOpen((prev) => !prev)}
            className="size-9 rounded-full sm:hidden"
          >
            {mobileSearchOpen ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Search className="size-4" aria-hidden="true" />
            )}
          </Button>

          <NotificationBell />

          <div ref={menuContainerRef} className="relative">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Mở menu tài khoản"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="h-10 gap-2 rounded-full pl-1.5 pr-2.5"
            >
              <UserAvatar fullName={user.fullName} avatarUrl={avatarUrl} size="sm" />
              <span className="hidden max-w-[130px] truncate text-sm font-medium text-foreground lg:inline">
                {user.fullName}
              </span>
              <ChevronDown
                className={cn(
                  'size-4 text-muted-foreground transition-transform',
                  menuOpen ? 'rotate-180' : null,
                )}
                aria-hidden="true"
              />
            </Button>

            {menuOpen ? (
              <div
                role="menu"
                aria-label="Menu tài khoản"
                className="absolute right-0 mt-2 w-64 origin-top-right rounded-xl border bg-background p-1.5 shadow-lg"
              >
                <Link
                  href={profilePath}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="mb-1 flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5 transition-colors hover:bg-muted"
                >
                  <UserAvatar fullName={user.fullName} avatarUrl={avatarUrl} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {user.fullName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">@{effectiveHandle}</p>
                  </div>
                </Link>

                <div className="space-y-0.5 py-1">
                  <Link
                    href="/"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted md:hidden"
                  >
                    <Home className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Trang chủ</span>
                  </Link>

                  <Link
                    href={profilePath}
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <UserCircle2 className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Trang cá nhân</span>
                  </Link>

                  <Link
                    href="/settings/profile"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <Pencil className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Chỉnh sửa hồ sơ</span>
                  </Link>

                  <Link
                    href="/settings/privacy"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Quyền riêng tư</span>
                  </Link>

                  <Link
                    href="/settings/account"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <User className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Tổng quan tài khoản</span>
                  </Link>

                  <Link
                    href="/settings/security"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Mật khẩu &amp; Bảo mật</span>
                  </Link>

                  <Link
                    href="/settings/devices"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <MonitorSmartphone
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>Thiết bị đăng nhập</span>
                  </Link>
                </div>

                <div className="my-1 border-t" />

                <button
                  type="button"
                  role="menuitem"
                  disabled={loggingOut}
                  onClick={() => void handleLogout()}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                >
                  {loggingOut ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <LogOut className="size-4" aria-hidden="true" />
                  )}
                  <span>{loggingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {mobileSearchOpen ? (
        <div className="border-t bg-background px-4 py-2.5 sm:hidden">
          <UserSearchBar className="max-w-none" />
        </div>
      ) : null}
    </header>
  );
}
