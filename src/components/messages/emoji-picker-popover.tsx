'use client';

import * as React from 'react';
import { Smile } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CHAT_EMOJI_CATEGORIES } from '@/lib/chat/emoji';
import { sanitizeChatPlaintext } from '@/lib/e2ee/utils';
import { cn } from '@/lib/utils';

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
  const [open, setOpen] = React.useState(false);
  const [activeCategoryId, setActiveCategoryId] = React.useState<string>('smileys');
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const activeCategory =
    CHAT_EMOJI_CATEGORIES.find((cat) => cat.id === activeCategoryId) ?? CHAT_EMOJI_CATEGORIES[0]!;

  function handlePick(rawEmoji: string) {
    const clean = sanitizeChatPlaintext(rawEmoji);
    if (clean) {
      onSelectEmoji(clean);
    }
  }

  return (
    <div ref={containerRef} className="relative flex shrink-0 items-center">
      <Button
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

      {open ? (
        <div
          role="dialog"
          aria-label="Bảng biểu tượng cảm xúc"
          className={cn(
            'absolute left-0 z-50 w-72 rounded-2xl border bg-background p-3 shadow-xl',
            compact ? 'bottom-11' : 'bottom-12',
          )}
        >
          <div className="mb-2 flex items-center gap-1 border-b pb-2">
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
        </div>
      ) : null}
    </div>
  );
}
