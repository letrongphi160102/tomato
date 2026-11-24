'use client';

import * as React from 'react';
import { MoreHorizontal, Pencil, RotateCcw, Trash2, Undo2 } from 'lucide-react';

import type { DecryptedMessageViewItem } from '@/components/messages/chat-store-context';
import type { ImageLightboxTarget } from '@/components/messages/image-lightbox-modal';
import {
  canDeleteMessageForMe,
  canEditMessage,
  canRecallMessage,
  getMessageBubbleRadiusClasses,
  RECALLED_MESSAGE_PLACEHOLDER,
} from '@/components/messages/message-actions';
import {
  formatExactMessageTooltipTimeVi,
  type ClusteredMessageEntry,
} from '@/components/messages/message-grouping';
import { MessageMediaContent } from '@/components/messages/message-media-content';
import { UserAvatar } from '@/components/profile/user-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ChatPeerUserDto } from '@/modules/chat';

export interface MessageBubbleRowProps {
  readonly entry: ClusteredMessageEntry<DecryptedMessageViewItem>;
  readonly index: number;
  readonly peer: ChatPeerUserDto;
  readonly variant: 'full' | 'compact';
  readonly nowMs: number;
  readonly isBeingEdited?: boolean;
  readonly isTapSelected?: boolean;
  readonly onTapToggle?: (clientMsgId: string) => void;
  readonly onStartEdit: (item: DecryptedMessageViewItem) => void;
  readonly onRequestRecall: (item: DecryptedMessageViewItem) => void;
  readonly onDeleteForMe: (item: DecryptedMessageViewItem) => void;
  readonly onRetryFailed: (clientMsgId: string, plaintext: string) => void;
  readonly onOpenLightbox?: (target: ImageLightboxTarget) => void;
}

export function MessageBubbleRow({
  entry,
  index,
  peer,
  variant,
  nowMs,
  isBeingEdited = false,
  isTapSelected = false,
  onTapToggle,
  onStartEdit,
  onRequestRecall,
  onDeleteForMe,
  onRetryFailed,
  onOpenLightbox,
}: MessageBubbleRowProps) {
  const {
    item,
    clusterPosition,
    showPeerAvatar,
    timeDividerLabel,
    isLastReadByPeer,
    isLatestOwnSentUnread,
  } = entry;

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [menuOpenedAtMs, setMenuOpenedAtMs] = React.useState<number>(nowMs);

  const effectiveNowMs = menuOpen ? Math.max(nowMs, menuOpenedAtMs) : nowMs;
  const isCompact = variant === 'compact';
  const isMine = item.dto.isOwnMessage;
  const isRecalled = item.dto.recalledAt !== null;
  const isEdited = item.dto.editedAt !== null && !isRecalled;
  const isNewCluster = clusterPosition === 'single' || clusterPosition === 'first';

  const allowEdit = canEditMessage(item, effectiveNowMs);
  const allowRecall = canRecallMessage(item, effectiveNowMs);
  const allowDeleteForMe = canDeleteMessageForMe(item);
  const hasAnyMenuAction = allowEdit || allowRecall || allowDeleteForMe;

  const exactTooltipTime = formatExactMessageTooltipTimeVi(item.dto.createdAt);
  const tooltipLabel =
    exactTooltipTime && isEdited ? `${exactTooltipTime} • Đã chỉnh sửa` : exactTooltipTime;

  return (
    <React.Fragment>
      {timeDividerLabel ? (
        <div className={cn('flex justify-center', isCompact ? 'my-2.5' : 'my-3.5')}>
          <span
            className={cn(
              'rounded-full bg-muted/50 py-0.5 font-medium text-muted-foreground',
              isCompact ? 'px-2.5 text-[10px]' : 'px-3 text-[11px]',
            )}
          >
            {timeDividerLabel}
          </span>
        </div>
      ) : null}

      <div
        className={cn(
          'group/msg flex flex-col',
          isMine ? 'items-end' : 'items-start',
          index === 0 || timeDividerLabel
            ? 'mt-0.5'
            : isNewCluster
              ? isCompact
                ? 'mt-2.5'
                : 'mt-3'
              : 'mt-0.5',
        )}
      >
        <div
          className={cn(
            'flex items-end',
            isCompact ? 'max-w-[90%] gap-1.5' : 'max-w-[85%] gap-2',
            isMine ? 'flex-row-reverse' : 'flex-row',
          )}
        >
          {!isMine ? (
            showPeerAvatar ? (
              <UserAvatar
                fullName={peer.fullName}
                avatarUrl={peer.avatarUrl}
                size="xs"
                className={cn('shrink-0', isCompact ? 'size-6' : 'size-7')}
              />
            ) : (
              <span aria-hidden="true" className={cn('shrink-0', isCompact ? 'w-6' : 'w-7')} />
            )
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <div
                tabIndex={0}
                onClick={() => onTapToggle?.(item.dto.clientMsgId)}
                className={cn(
                  'min-w-0 leading-relaxed break-words whitespace-pre-wrap transition-opacity focus:outline-none',
                  !isRecalled && item.dto.messageType === 'image' && !item.decryptionFailed
                    ? 'overflow-hidden border border-border/60 p-0 shadow-2xs'
                    : isCompact
                      ? 'px-3 py-1.5 text-xs'
                      : 'px-3.5 py-2 text-sm',
                  getMessageBubbleRadiusClasses(isMine, clusterPosition),
                  isRecalled
                    ? 'border border-dashed border-border/80 bg-transparent italic text-muted-foreground'
                    : item.dto.messageType === 'image' && !item.decryptionFailed
                      ? 'bg-muted/40'
                      : isMine
                        ? 'bg-primary text-primary-foreground shadow-2xs'
                        : 'border bg-muted/60 text-foreground shadow-2xs',
                  !isRecalled && item.decryptionFailed ? 'italic opacity-80' : null,
                  item.sending ? 'opacity-85' : null,
                  item.sendError ? 'ring-1 ring-destructive/60 opacity-90' : null,
                  isBeingEdited
                    ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background'
                    : null,
                )}
              >
                {isRecalled ? (
                  RECALLED_MESSAGE_PLACEHOLDER
                ) : !item.decryptionFailed &&
                  (item.dto.messageType === 'image' || item.dto.messageType === 'voice') ? (
                  <MessageMediaContent
                    item={item}
                    isMine={isMine}
                    isCompact={isCompact}
                    onOpenLightbox={onOpenLightbox}
                  />
                ) : (
                  item.plaintext
                )}
              </div>
            </TooltipTrigger>
            {tooltipLabel ? (
              <TooltipContent side={isMine ? 'left' : 'right'}>{tooltipLabel}</TooltipContent>
            ) : null}
          </Tooltip>

          {hasAnyMenuAction ? (
            <div
              className={cn(
                'flex shrink-0 items-center self-center transition-opacity duration-150',
                menuOpen || isTapSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100',
              )}
            >
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(nextOpen) => {
                  if (nextOpen) {
                    setMenuOpenedAtMs(Date.now());
                  }
                  setMenuOpen(nextOpen);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Tùy chọn tin nhắn"
                    onClick={(event) => event.stopPropagation()}
                    className={cn(
                      'inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isCompact ? 'size-6' : 'size-7',
                    )}
                  >
                    <MoreHorizontal
                      className={cn(isCompact ? 'size-3.5' : 'size-4')}
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={isMine ? 'end' : 'start'} sideOffset={4}>
                  {allowEdit ? (
                    <DropdownMenuItem onSelect={() => onStartEdit(item)}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                      <span>Chỉnh sửa</span>
                    </DropdownMenuItem>
                  ) : null}

                  {allowRecall ? (
                    <DropdownMenuItem onSelect={() => onRequestRecall(item)}>
                      <Undo2 className="size-3.5" aria-hidden="true" />
                      <span>Thu hồi</span>
                    </DropdownMenuItem>
                  ) : null}

                  {allowDeleteForMe ? (
                    <DropdownMenuItem
                      onSelect={() => onDeleteForMe(item)}
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      <span>Xóa ở phía bạn</span>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>

        {isEdited ? (
          <span
            className={cn(
              'mt-0.5 text-[10px] text-muted-foreground',
              isMine ? 'px-1' : isCompact ? 'pl-8' : 'pl-9',
            )}
          >
            Đã chỉnh sửa
          </span>
        ) : null}

        {item.sending ? (
          <span className="mt-0.5 px-1 text-[10px] text-muted-foreground">Đang gửi...</span>
        ) : null}

        {item.sendError ? (
          <div
            className={cn(
              'mt-1 flex items-center gap-1.5 px-1 text-destructive',
              isCompact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            <span>Không gửi được</span>
            {item.dto.messageType === 'text' ? (
              <button
                type="button"
                onClick={() => onRetryFailed(item.dto.clientMsgId, item.plaintext)}
                className="inline-flex items-center gap-1 font-semibold underline hover:opacity-80"
              >
                <RotateCcw className={cn(isCompact ? 'size-2.5' : 'size-3')} aria-hidden="true" />
                <span>Thử lại</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {isLastReadByPeer ? (
          <div
            aria-label="Đã xem"
            className={cn(
              'mt-1 flex items-center gap-1 px-1 font-medium text-muted-foreground',
              isCompact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            <UserAvatar
              fullName={peer.fullName}
              avatarUrl={peer.avatarUrl}
              size="xs"
              className="size-3.5"
            />
            <span>Đã xem</span>
          </div>
        ) : isLatestOwnSentUnread ? (
          <span
            aria-label="Đã gửi"
            className={cn(
              'mt-1 px-1 text-muted-foreground',
              isCompact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            Đã gửi
          </span>
        ) : null}
      </div>
    </React.Fragment>
  );
}
