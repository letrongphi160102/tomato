'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Search, X } from 'lucide-react';

import { TomatoLogo } from '@/components/brand/tomato-logo';
import { NotificationBell } from '@/components/layout/notification-bell';
import { UserSearchBar } from '@/components/layout/user-search-bar';
import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PublicUserProfile } from '@/modules/auth/session.service';

export interface AppTopBarProps {
  readonly user: PublicUserProfile;
  readonly avatarUrl?: string | null;
  readonly handle?: string;
}

export function AppTopBar({ user, avatarUrl = null, handle }: AppTopBarProps) {
  const pathname = usePathname();
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(false);

  const effectiveHandle = handle ?? user.username;
  const profilePath = `/u/${encodeURIComponent(effectiveHandle)}`;
  const isOwnProfileActive = pathname === profilePath;

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="flex h-14 w-full items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex shrink-0 items-center">
          <Link
            href="/"
            aria-label="Trang chủ Tomato"
            className="inline-flex shrink-0 items-center rounded-md px-1 py-1 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TomatoLogo size="sm" priority />
          </Link>
        </div>

        <div className="hidden flex-1 justify-center px-2 sm:flex">
          <UserSearchBar />
        </div>

        <div className="flex shrink-0 items-center gap-2">
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

          <Link
            href={profilePath}
            aria-label={`Trang cá nhân của ${user.fullName}`}
            aria-current={isOwnProfileActive ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2.5 rounded-full border py-1 pl-1.5 pr-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isOwnProfileActive
                ? 'border-primary/30 bg-primary/10'
                : 'border-border/70 bg-background hover:bg-muted/70',
            )}
          >
            <UserAvatar fullName={user.fullName} avatarUrl={avatarUrl} size="sm" />
            <div className="hidden min-w-0 text-left sm:block">
              <p className="max-w-[136px] truncate text-xs font-semibold leading-tight text-foreground">
                {user.fullName}
              </p>
              <p className="text-[11px] leading-tight text-muted-foreground">Trang cá nhân</p>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
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
