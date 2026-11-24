'use client';

import { Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface MessageEditBannerProps {
  readonly originalText: string;
  readonly compact?: boolean;
  readonly saving?: boolean;
  readonly onCancel: () => void;
}

export function MessageEditBanner({
  originalText,
  compact = false,
  saving = false,
  onCancel,
}: MessageEditBannerProps) {
  return (
    <div
      role="status"
      aria-label="Đang chỉnh sửa tin nhắn"
      className={cn(
        'mb-2 flex items-center justify-between gap-2 rounded-xl border bg-muted/50',
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Pencil
          className={cn('shrink-0 text-primary', compact ? 'size-3' : 'size-3.5')}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className={cn('font-semibold text-foreground', compact ? 'text-[11px]' : 'text-xs')}>
            Đang chỉnh sửa tin nhắn
          </p>
          <p
            className={cn(
              'truncate text-muted-foreground',
              compact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            {originalText}
          </p>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={saving}
        onClick={onCancel}
        aria-label="Hủy chỉnh sửa"
        className={cn(
          'shrink-0 rounded-lg text-muted-foreground hover:text-foreground',
          compact ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
        )}
      >
        <X className={cn(compact ? 'size-3' : 'size-3.5')} aria-hidden="true" />
        <span>Hủy</span>
      </Button>
    </div>
  );
}
