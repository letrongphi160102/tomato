'use client';

import * as React from 'react';
import { Bell, BellOff, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface ConversationActionsMenuProps {
  readonly peerFullName: string;
  readonly compact?: boolean;
  readonly alwaysVisible?: boolean;
  readonly isPinned?: boolean;
  readonly isMuted?: boolean;
  readonly canPin?: boolean;
  readonly showDelete?: boolean;
  readonly onTogglePin?: () => void;
  readonly onToggleMute?: () => void;
  readonly onRequestDeleteConversation?: () => void;
}

export function ConversationActionsMenu({
  peerFullName,
  compact = false,
  alwaysVisible = false,
  isPinned = false,
  isMuted = false,
  canPin = false,
  showDelete = true,
  onTogglePin,
  onToggleMute,
  onRequestDeleteConversation,
}: ConversationActionsMenuProps) {
  const [open, setOpen] = React.useState(false);

  const hasPinAction = canPin && typeof onTogglePin === 'function';
  const hasMuteAction = typeof onToggleMute === 'function';
  const hasDeleteAction = showDelete && typeof onRequestDeleteConversation === 'function';

  if (!hasPinAction && !hasMuteAction && !hasDeleteAction) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Tùy chọn cuộc trò chuyện với ${peerFullName}`}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            compact ? 'size-7' : 'size-8',
            alwaysVisible || open
              ? 'opacity-100'
              : 'opacity-0 group-hover/conv:opacity-100 group-focus-within/conv:opacity-100',
          )}
        >
          <MoreHorizontal className={cn(compact ? 'size-3.5' : 'size-4')} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {hasPinAction ? (
          <DropdownMenuItem onSelect={() => onTogglePin?.()}>
            {isPinned ? (
              <>
                <PinOff className="size-3.5" aria-hidden="true" />
                <span>Bỏ ghim</span>
              </>
            ) : (
              <>
                <Pin className="size-3.5" aria-hidden="true" />
                <span>Ghim đoạn chat</span>
              </>
            )}
          </DropdownMenuItem>
        ) : null}

        {hasMuteAction ? (
          <DropdownMenuItem onSelect={() => onToggleMute?.()}>
            {isMuted ? (
              <>
                <Bell className="size-3.5" aria-hidden="true" />
                <span>Bật thông báo</span>
              </>
            ) : (
              <>
                <BellOff className="size-3.5" aria-hidden="true" />
                <span>Tắt thông báo</span>
              </>
            )}
          </DropdownMenuItem>
        ) : null}

        {hasDeleteAction && (hasPinAction || hasMuteAction) ? <DropdownMenuSeparator /> : null}

        {hasDeleteAction ? (
          <DropdownMenuItem
            onSelect={() => onRequestDeleteConversation?.()}
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            <span>Xóa đoạn chat</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
