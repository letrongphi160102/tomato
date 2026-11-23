'use client';

/* eslint-disable @next/next/no-img-element -- Ảnh đại diện đã được máy chủ tối ưu sẵn 512x512 nên dùng thẻ <img> chuẩn để không tiêu tốn hạn mức chuyển đổi ảnh. */

import * as React from 'react';

import { getUserInitials } from '@/lib/user-display';
import { cn } from '@/lib/utils';

export type UserAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const SIZE_CLASSES: Record<UserAvatarSize, string> = {
  xs: 'size-7 text-[11px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
  '2xl': 'size-24 text-2xl sm:size-36 sm:text-4xl',
};

export interface UserAvatarProps {
  readonly fullName: string;
  readonly avatarUrl?: string | null;
  readonly size?: UserAvatarSize;
  readonly className?: string;
}

export function UserAvatar({ fullName, avatarUrl, size = 'md', className }: UserAvatarProps) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);

  const initials = getUserInitials(fullName);
  const showImage = Boolean(avatarUrl) && failedUrl !== avatarUrl;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary font-semibold text-primary-foreground select-none ring-1 ring-border/60',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {showImage ? (
        <img
          src={avatarUrl ?? undefined}
          alt={`Ảnh đại diện của ${fullName}`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl ?? null)}
          className="size-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
