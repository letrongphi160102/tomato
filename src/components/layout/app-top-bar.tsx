'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronDown,
  Home,
  KeyRound,
  Loader2,
  LogOut,
  MonitorSmartphone,
  Settings,
  User,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth-client';
import { getUserInitials } from '@/lib/user-display';
import { cn } from '@/lib/utils';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AppTopBarProps {
  readonly user: PublicUserProfile;
}

export function AppTopBar({ user }: AppTopBarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const menuContainerRef = React.useRef<HTMLDivElement | null>(null);

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
    try {
      await authFetch('/api/v1/auth/logout', { method: 'POST' }, { retryOnUnauthorized: false });
    } finally {
      setMenuOpen(false);
      setLoggingOut(false);
      router.replace('/');
      router.refresh();
    }
  }

  const isHomeActive = pathname === '/';
  const isSettingsActive = pathname.startsWith('/settings');
  const initials = getUserInitials(user.fullName);

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md px-1 py-1 text-xl font-bold tracking-tight text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-extrabold text-primary-foreground">
              T
            </span>
            <span>TOMATO</span>
          </Link>

          <nav aria-label="Điều hướng chính" className="hidden items-center gap-1 sm:flex">
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
              href="/settings/account"
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
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              {initials}
            </span>
            <span className="hidden max-w-[140px] truncate text-sm font-medium text-foreground sm:inline">
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
              <div className="mb-1 rounded-lg bg-muted/50 px-3 py-2.5">
                <p className="truncate text-sm font-semibold text-foreground">{user.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
              </div>

              <div className="space-y-0.5 py-1">
                <Link
                  href="/"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted sm:hidden"
                >
                  <Home className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Trang chủ</span>
                </Link>

                <Link
                  href="/settings/account"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                >
                  <User className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span>Cài đặt &amp; Quyền riêng tư</span>
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
                  <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden="true" />
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
    </header>
  );
}
