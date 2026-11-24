'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, Link2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { buildProfileShareUrl } from '@/lib/profile-share';
import { cn } from '@/lib/utils';

export interface ShareProfileOption {
  readonly id: 'copy-link';
  readonly label: string;
  readonly activeLabel?: string;
}

const SHARE_PROFILE_OPTIONS: readonly ShareProfileOption[] = [
  {
    id: 'copy-link',
    label: 'Sao chép liên kết',
    activeLabel: 'Đã sao chép liên kết',
  },
];

export interface ShareProfileModalProps {
  readonly open: boolean;
  readonly handle: string;
  readonly onClose: () => void;
}

async function copyTextWithSafeFallback(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Tiếp tục thử fallback an toàn bên dưới nếu trình duyệt chặn Clipboard API.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'fixed left-[-9999px] top-[-9999px] opacity-0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function ShareProfileModal({ open, handle, onClose }: ShareProfileModalProps) {
  const titleId = React.useId();
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);
  const resetTimerRef = React.useRef<number | null>(null);

  const handleDismiss = React.useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setCopied(false);
    setCopyError(null);
    onClose();
  }, [onClose]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        handleDismiss();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, [open, handleDismiss]);

  const handleCopyLink = React.useCallback(async () => {
    setCopyError(null);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const shareUrl = buildProfileShareUrl(origin, handle);
    const ok = await copyTextWithSafeFallback(shareUrl);

    if (!ok) {
      setCopyError('Không thể sao chép liên kết lúc này. Vui lòng thử lại.');
      return;
    }

    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 2500);
  }, [handle]);

  function handleOptionClick(optionId: ShareProfileOption['id']) {
    if (optionId === 'copy-link') {
      void handleCopyLink();
    }
  }

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleDismiss();
        }
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="relative flex items-center justify-center border-b px-4 py-3.5">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            Chia sẻ trang cá nhân
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Đóng hộp thoại chia sẻ"
            onClick={handleDismiss}
            className="absolute right-2.5 size-8 rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="p-2.5">
          <ul className="space-y-1">
            {SHARE_PROFILE_OPTIONS.map((option) => {
              const isCopyOptionActive = option.id === 'copy-link' && copied;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => handleOptionClick(option.id)}
                    className={cn(
                      'flex w-full items-center gap-3.5 rounded-xl px-3.5 py-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isCopyOptionActive
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'text-foreground hover:bg-muted/70',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-full border transition-colors',
                        isCopyOptionActive
                          ? 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
                          : 'border-border bg-muted/40 text-foreground',
                      )}
                    >
                      {isCopyOptionActive ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : (
                        <Link2 className="size-4" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {isCopyOptionActive && option.activeLabel ? option.activeLabel : option.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {copyError ? (
            <p role="alert" className="px-3.5 pt-2 pb-1 text-xs font-medium text-destructive">
              {copyError}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
