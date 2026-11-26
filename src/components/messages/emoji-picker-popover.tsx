'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Smile } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CHAT_EMOJI_CATEGORIES } from '@/lib/chat/emoji';
import { sanitizeChatPlaintext } from '@/lib/e2ee/utils';
import { cn } from '@/lib/utils';

const EMPTY_SUBSCRIBE = () => () => undefined;

export interface EmojiPickerPopoverProps {
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onSelectEmoji: (emoji: string) => void;
}

export function EmojiPickerPopover({
  compact = false,
  disabled = false,
  onSelectEmoji,
}: EmojiPickerPopoverProps) {
  const isClient = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
  const [open, setOpen] = React.useState(false);
  const [activeCategoryId, setActiveCategoryId] = React.useState<string>('smileys');
  const [coords, setCoords] = React.useState<{
    readonly bottom: number;
    readonly left: number;
  } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  const updatePopoverPosition = React.useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') {
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverMaxWidth = Math.min(288, window.innerWidth - 24);
    const clampedLeft = Math.max(12, Math.min(rect.left, window.innerWidth - popoverMaxWidth - 12));
    const bottomOffset = Math.max(12, window.innerHeight - rect.top + 8);
    setCoords({
      bottom: bottomOffset,
      left: clampedLeft,
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    updatePopoverPosition();

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    }

    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, updatePopoverPosition]);

  const activeCategory =
    CHAT_EMOJI_CATEGORIES.find((cat) => cat.id === activeCategoryId) ?? CHAT_EMOJI_CATEGORIES[0]!;

  function handlePick(rawEmoji: string) {
    const clean = sanitizeChatPlaintext(rawEmoji);
    if (clean) {
      onSelectEmoji(clean);
    }
  }

  return (
    <div className="relative flex shrink-0 items-center">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label="Chọn biểu tượng cảm xúc"
        aria-expanded={open}
        title="Biểu tượng cảm xúc"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'shrink-0 rounded-full text-muted-foreground hover:text-foreground',
          compact ? 'size-8' : 'size-9',
        )}
      >
        <Smile className={cn(compact ? 'size-[18px]' : 'size-5')} aria-hidden="true" />
      </Button>

      {open && isClient && coords
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Bảng biểu tượng cảm xúc"
              style={{
                bottom: `${coords.bottom}px`,
                left: `${coords.left}px`,
              }}
              className="fixed z-[60] w-[min(18rem,calc(100vw-1.5rem))] rounded-2xl border bg-background p-3 shadow-xl"
            >
              <div className="mb-2 flex flex-wrap items-center gap-1 border-b pb-2">
                {CHAT_EMOJI_CATEGORIES.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategoryId(category.id)}
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                      activeCategory.id === category.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {category.label}
                  </button>
                ))}
              </div>

              <div className="grid max-h-48 grid-cols-6 gap-1 overflow-y-auto p-0.5">
                {activeCategory.emojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => handlePick(emoji)}
                    className="flex size-9 items-center justify-center rounded-lg text-lg transition-transform hover:scale-110 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
