'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, KeyRound, Pin, PinOff, X } from 'lucide-react';

import type { CachedPinnedMessagesState } from '@/components/messages/chat-store-context';
import {
  getPinnedMessagePreviewText,
  PINNED_MESSAGE_NEEDS_PIN_LABEL,
} from '@/components/messages/message-actions';
import { formatConversationShortTimeVi } from '@/components/messages/message-grouping';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatPeerUserDto } from '@/modules/chat';

const EMPTY_SUBSCRIBE = () => () => undefined;

export interface PinnedMessagesBarProps {
  readonly pinnedState: CachedPinnedMessagesState | null;
  readonly peer: ChatPeerUserDto;
  readonly compact?: boolean;
  readonly needsPinRestore: boolean;
  readonly listOpen: boolean;
  readonly onOpenList: () => void;
  readonly onCloseList: () => void;
  readonly onJumpToMessage: (messagePublicId: string) => void;
  readonly onUnpinMessage: (messagePublicId: string) => Promise<void>;
  readonly onRequestPinRestore?: () => void;
}

/**
 * Thanh ghim tin nhắn thu gọn ngay dưới header đoạn chat + hộp thoại danh sách tối đa 5 tin nhắn đã ghim.
 * Hỗ trợ mượt mà trạng thái chưa nhập mã PIN (`needs_restore`) và tự giải mã ngay khi mở khóa.
 */
export function PinnedMessagesBar({
  pinnedState,
  peer,
  compact = false,
  needsPinRestore,
  listOpen,
  onOpenList,
  onCloseList,
  onJumpToMessage,
  onUnpinMessage,
  onRequestPinRestore,
}: PinnedMessagesBarProps) {
  const isClient = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
  const [unpinningId, setUnpinningId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!listOpen) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseList();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [listOpen, onCloseList]);

  const items = pinnedState?.items ?? [];
  const totalPinnedCount = pinnedState?.totalPinnedCount ?? 0;
  const hiddenPinnedCount = pinnedState?.hiddenPinnedCount ?? 0;
  const maxPinnedMessages = pinnedState?.maxPinnedMessages ?? 5;

  const hasVisiblePins = items.length > 0;
  const latestItem = items[0] ?? null;

  async function handleUnpinClick(messagePublicId: string) {
    if (unpinningId) {
      return;
    }
    setUnpinningId(messagePublicId);
    try {
      await onUnpinMessage(messagePublicId);
    } finally {
      setUnpinningId(null);
    }
  }

  return (
    <>
      {hasVisiblePins && latestItem ? (
        <div
          className={cn(
            'flex items-center justify-between gap-2 border-b bg-muted/30',
            compact ? 'px-3 py-1.5' : 'px-4 py-2',
          )}
        >
          <button
            type="button"
            onClick={onOpenList}
            className="flex min-w-0 flex-1 items-center gap-2 text-left transition-opacity hover:opacity-85"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Pin className="size-3.5" aria-hidden="true" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'font-semibold text-foreground',
                    compact ? 'text-[11px]' : 'text-xs',
                  )}
                >
                  Tin nhắn đã ghim
                </span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {items.length}/{maxPinnedMessages}
                </span>
              </div>
              <p
                className={cn(
                  'truncate text-muted-foreground',
                  compact ? 'text-[11px]' : 'text-xs',
                )}
              >
                {needsPinRestore && latestItem.message.decryptionFailed
                  ? PINNED_MESSAGE_NEEDS_PIN_LABEL
                  : getPinnedMessagePreviewText(latestItem.message, {
                      needsPinSync: needsPinRestore,
                    })}
              </p>
            </div>
          </button>

          {needsPinRestore && latestItem.message.decryptionFailed && onRequestPinRestore ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRequestPinRestore}
              className="h-6 shrink-0 gap-1 rounded-lg px-2 text-[11px]"
            >
              <KeyRound className="size-3" aria-hidden="true" />
              <span>Nhập mã PIN</span>
            </Button>
          ) : (
            <button
              type="button"
              onClick={onOpenList}
              aria-label="Xem danh sách tin nhắn đã ghim"
              className="inline-flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {!compact ? <span>Xem tất cả</span> : null}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}

      {listOpen && isClient
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Danh sách tin nhắn đã ghim"
              onClick={onCloseList}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
            >
              <div
                onClick={(event) => event.stopPropagation()}
                className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
              >
                <header className="flex items-center justify-between border-b px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <Pin className="size-4 text-primary" aria-hidden="true" />
                    <h2 className="text-sm font-semibold text-foreground">
                      Tin nhắn đã ghim ({totalPinnedCount}/{maxPinnedMessages})
                    </h2>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Đóng danh sách tin nhắn đã ghim"
                    onClick={onCloseList}
                    className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </header>

                <div className="flex-1 overflow-y-auto p-3">
                  {items.length === 0 ? (
                    <div className="py-10 text-center">
                      <p className="text-xs font-medium text-foreground">
                        Chưa có tin nhắn nào được ghim
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Bạn có thể ghim tối đa {maxPinnedMessages} tin nhắn quan trọng trong cuộc
                        trò chuyện này.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((entry) => {
                        const isMine = entry.message.dto.isOwnMessage;
                        const senderLabel = isMine ? 'Bạn' : peer.fullName;
                        const preview = getPinnedMessagePreviewText(entry.message, {
                          needsPinSync: needsPinRestore,
                        });
                        const isUnpinning = unpinningId === entry.message.dto.public_id;

                        return (
                          <li
                            key={entry.message.dto.public_id}
                            className="flex items-start justify-between gap-2 rounded-xl border bg-muted/25 p-3 transition-colors hover:bg-muted/50"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                onCloseList();
                                onJumpToMessage(entry.message.dto.public_id);
                              }}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-semibold text-foreground">
                                  {senderLabel}
                                </span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {formatConversationShortTimeVi(entry.message.dto.createdAt)}
                                </span>
                              </div>
                              <p
                                className={cn(
                                  'mt-1 line-clamp-2 text-xs leading-relaxed',
                                  entry.message.decryptionFailed
                                    ? 'italic text-muted-foreground'
                                    : 'text-foreground/90',
                                )}
                              >
                                {preview}
                              </p>
                            </button>

                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={isUnpinning}
                              onClick={() => void handleUnpinClick(entry.message.dto.public_id)}
                              className="h-7 shrink-0 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-destructive"
                            >
                              <PinOff className="size-3.5" aria-hidden="true" />
                              <span>Bỏ ghim</span>
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {hiddenPinnedCount > 0 ? (
                    <p className="mt-3 rounded-xl border border-dashed bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                      Có {hiddenPinnedCount} tin nhắn đã ghim cũ hơn không còn hiển thị ở phía bạn.
                      Khi danh sách đạt 5/5, bạn có thể chọn gỡ ghim tin cũ để ghim tin mới.
                    </p>
                  ) : null}

                  {needsPinRestore &&
                  items.some((i) => i.message.decryptionFailed) &&
                  onRequestPinRestore ? (
                    <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                      <span className="text-[11px] text-foreground">
                        {PINNED_MESSAGE_NEEDS_PIN_LABEL}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onCloseList();
                          onRequestPinRestore();
                        }}
                        className="h-7 shrink-0 rounded-lg px-2.5 text-[11px]"
                      >
                        Nhập mã PIN
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
