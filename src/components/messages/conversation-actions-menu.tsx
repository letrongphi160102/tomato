'use client';

import * as React from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface ConversationActionsMenuProps {
  readonly peerFullName: string;
  readonly compact?: boolean;
  readonly alwaysVisible?: boolean;
  readonly onRequestDeleteConversation: () => void;
}

export function ConversationActionsMenu({
  peerFullName,
  compact = false,
  alwaysVisible = false,
  onRequestDeleteConversation,
}: ConversationActionsMenuProps) {
  const [open, setOpen] = React.useState(false);

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
        <DropdownMenuItem
          onSelect={onRequestDeleteConversation}
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          <span>Xóa đoạn chat</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
