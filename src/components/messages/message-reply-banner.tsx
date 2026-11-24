'use client';

import * as React from 'react';
import { Reply, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MessageReplyBannerProps {
  readonly recipientLabel: string;
  readonly previewText: string;
  readonly compact?: boolean;
  readonly onCancel: () => void;
}

/**
 * Thanh xem trước tin nhắn đang trả lời đặt ngay phía trên ô soạn tin (phong cách Instagram).
 */
export function MessageReplyBanner({
  recipientLabel,
  previewText,
  compact = false,
  onCancel,
}: MessageReplyBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mb-2 flex items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/45',
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Reply
          className={cn('mt-0.5 shrink-0 text-primary', compact ? 'size-3.5' : 'size-4')}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate font-semibold text-foreground',
              compact ? 'text-[11px]' : 'text-xs',
            )}
          >
            Đang trả lời {recipientLabel}
          </p>
          <p className={cn('truncate text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
            {previewText}
          </p>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Hủy trả lời tin nhắn"
        title="Hủy"
        onClick={onCancel}
        className={cn(
          'shrink-0 rounded-full text-muted-foreground hover:text-foreground',
          compact ? 'size-6' : 'size-7',
        )}
      >
        <X className={cn(compact ? 'size-3.5' : 'size-4')} aria-hidden="true" />
      </Button>
    </div>
  );
}
