'use client';

import * as React from 'react';
import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly loading?: boolean;
  readonly errorMessage?: string | null;
  readonly children?: React.ReactNode;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Hủy',
  destructive = false,
  loading = false,
  errorMessage = null,
  children,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !loading) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, loading, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="space-y-1.5">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {title}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Đóng hộp thoại"
            disabled={loading}
            onClick={onClose}
            className="size-8 shrink-0 rounded-full"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {children ? <div className="px-5 pt-4">{children}</div> : null}

        {errorMessage ? (
          <p role="alert" className="px-5 pt-3 text-sm font-medium text-destructive">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2.5 border-t bg-muted/20 px-5 py-3.5">
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            disabled={loading}
            onClick={() => void onConfirm()}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>Đang xử lý...</span>
              </>
            ) : (
              <span>{confirmLabel}</span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
