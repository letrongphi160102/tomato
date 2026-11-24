'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';

import { CHAT_EMOJI_CATEGORIES, QUICK_REACTION_EMOJIS } from '@/lib/chat/emoji';
import { cn } from '@/lib/utils';

const EMPTY_SUBSCRIBE = () => () => undefined;

export interface MessageReactionPickerProps {
  readonly open: boolean;
  readonly anchorEl: HTMLElement | null;
  readonly activeEmoji: string | null;
  readonly onSelectEmoji: (emoji: string | null) => void;
  readonly onClose: () => void;
}

/**
 * Thanh chọn biểu tượng cảm xúc nhanh (6 cảm xúc + nút `+` mở bảng mở rộng).
 * Luôn hiển thị qua `createPortal(..., document.body)` ở tầng `z-50` và tính tọa độ động
 * để tuyệt đối không bị cắt góc bên trong cửa sổ nhắn tin nhỏ (`overflow-hidden`).
 */
function computePickerCoords(
  anchorEl: HTMLElement | null,
  expanded: boolean,
): { readonly top: number; readonly left: number } | null {
  if (!anchorEl || typeof window === 'undefined') {
    return null;
  }
  const rect = anchorEl.getBoundingClientRect();
  const estimatedWidth = expanded ? 288 : 272;
  const estimatedHeight = expanded ? 268 : 48;
  const margin = 8;

  let left = rect.left + rect.width / 2 - estimatedWidth / 2;
  left = Math.max(margin, Math.min(window.innerWidth - estimatedWidth - margin, left));

  let top = rect.top - estimatedHeight - 8;
  if (top < margin) {
    top = Math.min(window.innerHeight - estimatedHeight - margin, rect.bottom + 8);
  }
  top = Math.max(margin, top);

  return { top, left };
}

export function MessageReactionPicker({
  open,
  anchorEl,
  activeEmoji,
  onSelectEmoji,
  onClose,
}: MessageReactionPickerProps) {
  const isClient = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
  const [expanded, setExpanded] = React.useState(false);
  const [activeCategoryId, setActiveCategoryId] = React.useState<string>('smileys');
  const [, setViewportTick] = React.useState(0);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handleReposition = () => {
      setViewportTick((n) => n + 1);
    };
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  const coords = open && isClient ? computePickerCoords(anchorEl, expanded) : null;

  React.useEffect(() => {
    if (!open) {
      return;
    }
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (
        popoverRef.current &&
        target &&
        !popoverRef.current.contains(target) &&
        (!anchorEl || !anchorEl.contains(target))
      ) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorEl, onClose, open]);

  if (!open || !isClient || !coords) {
    return null;
  }

  const activeCategory =
    CHAT_EMOJI_CATEGORIES.find((c) => c.id === activeCategoryId) ?? CHAT_EMOJI_CATEGORIES[0]!;

  function handlePickEmoji(emoji: string) {
    const next = activeEmoji === emoji ? null : emoji;
    onSelectEmoji(next);
    setExpanded(false);
    onClose();
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Chọn biểu tượng cảm xúc"
      style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
      onClick={(event) => event.stopPropagation()}
      className="fixed z-50 rounded-2xl border bg-background/95 p-1.5 shadow-xl backdrop-blur-sm"
    >
      <div className="flex items-center gap-0.5">
        {QUICK_REACTION_EMOJIS.map((emoji) => {
          const isSelected = activeEmoji === emoji;
          return (
            <button
              key={emoji}
              type="button"
              aria-label={isSelected ? `Gỡ cảm xúc ${emoji}` : `Thả cảm xúc ${emoji}`}
              aria-pressed={isSelected}
              onClick={() => handlePickEmoji(emoji)}
              className={cn(
                'flex size-9 items-center justify-center rounded-full text-xl transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-muted',
              )}
            >
              {emoji}
            </button>
          );
        })}

        <button
          type="button"
          aria-label={expanded ? 'Thu gọn danh sách biểu tượng' : 'Chọn biểu tượng khác'}
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            'flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            expanded ? 'bg-muted text-foreground' : null,
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 w-72 border-t pt-2">
          <div className="mb-1.5 flex items-center gap-1">
            {CHAT_EMOJI_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategoryId(category.id)}
                className={cn(
                  'rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                  activeCategory.id === category.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {category.label}
              </button>
            ))}
          </div>

          <div className="grid max-h-44 grid-cols-7 gap-0.5 overflow-y-auto p-0.5">
            {activeCategory.emojis.map((emoji) => {
              const isSelected = activeEmoji === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handlePickEmoji(emoji)}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg text-lg transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-muted',
                  )}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
