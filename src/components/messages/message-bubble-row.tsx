'use client';

import * as React from 'react';
import {
  Copy,
  Forward,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Phone,
  PhoneMissed,
  Pin,
  PinOff,
  Reply,
  RotateCcw,
  Smile,
  Trash2,
  Undo2,
  Video,
} from 'lucide-react';

import type { DecryptedMessageViewItem } from '@/components/messages/chat-store-context';
import type { ImageLightboxTarget } from '@/components/messages/image-lightbox-modal';
import {
  canCopyMessage,
  canDeleteMessageForMe,
  canEditMessage,
  canForwardMessage,
  canPinMessage,
  canReactToMessage,
  canRecallMessage,
  canReplyToMessage,
  formatCallEventLabel,
  getMessageBubbleRadiusClasses,
  RECALLED_MESSAGE_PLACEHOLDER,
} from '@/components/messages/message-actions';
import {
  formatExactMessageTooltipTimeVi,
  formatMessageMenuTimestampVi,
  type ClusteredMessageEntry,
} from '@/components/messages/message-grouping';
import { MessageMediaContent } from '@/components/messages/message-media-content';
import { MessageReactionPicker } from '@/components/messages/message-reaction-picker';
import { UserAvatar } from '@/components/profile/user-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ChatPeerUserDto, ConversationSummaryDto } from '@/modules/chat';

export interface MessageBubbleRowProps {
  readonly entry: ClusteredMessageEntry<DecryptedMessageViewItem>;
  readonly index: number;
  readonly peer: ChatPeerUserDto;
  readonly currentUserPublicId?: string;
  readonly conversation?: ConversationSummaryDto | null;
  readonly variant: 'full' | 'compact';
  readonly nowMs: number;
  readonly isBeingEdited?: boolean;
  readonly isHighlighted?: boolean;
  readonly isTapSelected?: boolean;
  readonly onTapToggle?: (clientMsgId: string) => void;
  readonly onReact?: (item: DecryptedMessageViewItem, emoji: string | null) => void;
  readonly onReply?: (item: DecryptedMessageViewItem) => void;
  readonly onForward?: (item: DecryptedMessageViewItem) => void;
  readonly onCopy?: (item: DecryptedMessageViewItem) => void;
  readonly onTogglePin?: (item: DecryptedMessageViewItem) => void;
  readonly onJumpToMessage?: (targetMessagePublicId: string) => void;
  readonly onStartEdit: (item: DecryptedMessageViewItem) => void;
  readonly onRequestRecall: (item: DecryptedMessageViewItem) => void;
  readonly onDeleteForMe: (item: DecryptedMessageViewItem) => void;
  readonly onRetryFailed: (clientMsgId: string, plaintext: string) => void;
  readonly onOpenLightbox?: (target: ImageLightboxTarget) => void;
}

export const MessageBubbleRow = React.memo(function MessageBubbleRow({
  entry,
  index,
  peer,
  currentUserPublicId = '',
  conversation = null,
  variant,
  nowMs,
  isBeingEdited = false,
  isHighlighted = false,
  isTapSelected = false,
  onTapToggle,
  onReact,
  onReply,
  onForward,
  onCopy,
  onTogglePin,
  onJumpToMessage,
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
  const [reactionPickerOpen, setReactionPickerOpen] = React.useState(false);
  const [reactionAnchorEl, setReactionAnchorEl] = React.useState<HTMLElement | null>(null);
  const [menuOpenedAtMs, setMenuOpenedAtMs] = React.useState<number>(nowMs);

  const effectiveNowMs = menuOpen ? Math.max(nowMs, menuOpenedAtMs) : nowMs;
  const isCompact = variant === 'compact';
  const isMine = item.dto.isOwnMessage;
  const isRecalled = item.dto.recalledAt !== null;
  const isEdited = item.dto.editedAt !== null && !isRecalled;
  const isNewCluster = clusterPosition === 'single' || clusterPosition === 'first';
  const isPinned = Boolean(item.dto.isPinned) && !isRecalled;
  const isForwarded = Boolean(item.forwarded || item.dto.isForwarded) && !isRecalled;

  const reactions = React.useMemo(
    () => (isRecalled ? [] : (item.dto.reactions ?? [])),
    [isRecalled, item.dto.reactions],
  );
  const myReaction = React.useMemo(() => {
    if (!currentUserPublicId) {
      return null;
    }
    const norm = currentUserPublicId.toLowerCase();
    return reactions.find((r) => r.userPublicId.toLowerCase() === norm)?.emoji ?? null;
  }, [currentUserPublicId, reactions]);

  const allowReact = Boolean(onReact) && canReactToMessage(item, conversation);
  const allowReply = Boolean(onReply) && canReplyToMessage(item);
  const allowForward = Boolean(onForward) && canForwardMessage(item);
  const allowCopy = Boolean(onCopy) && canCopyMessage(item);
  const allowPin = Boolean(onTogglePin) && canPinMessage(item, conversation);
  const allowEdit = canEditMessage(item, effectiveNowMs);
  const allowRecall = canRecallMessage(item, effectiveNowMs);
  const allowDeleteForMe = canDeleteMessageForMe(item);

  const hasAnyMenuAction =
    allowForward || allowCopy || allowPin || allowEdit || allowRecall || allowDeleteForMe;
  const hasAnyQuickAction = allowReact || allowReply || hasAnyMenuAction;

  const exactTooltipTime = formatExactMessageTooltipTimeVi(item.dto.createdAt);
  const menuHeaderTime = formatMessageMenuTimestampVi(item.dto.createdAt);
  const tooltipLabel =
    exactTooltipTime && isEdited ? `${exactTooltipTime} • Đã chỉnh sửa` : exactTooltipTime;

  const hasReplyQuote = !isRecalled && Boolean(item.replyTo || item.dto.replyToMeta);
  const replyTargetPublicId =
    item.dto.replyToMeta?.messagePublicId ?? item.replyTo?.messagePublicId ?? null;
  const replyTargetSenderPublicId =
    item.dto.replyToMeta?.senderPublicId ?? item.replyTo?.senderPublicId ?? '';
  const isReplyTargetRecalled = Boolean(item.dto.replyToMeta?.recalledAt);
  const isReplyTargetDeletedForViewer = Boolean(item.dto.replyToMeta?.deletedForViewer);

  const replyHeadingLabel = React.useMemo(() => {
    if (!hasReplyQuote) {
      return '';
    }
    const repliedToSelf =
      replyTargetSenderPublicId.length > 0 &&
      replyTargetSenderPublicId.toLowerCase() === item.dto.senderPublicId.toLowerCase();
    if (isMine) {
      return repliedToSelf ? 'Bạn đã trả lời chính mình' : `Bạn đã trả lời ${peer.fullName}`;
    }
    return repliedToSelf
      ? `${peer.fullName} đã trả lời chính mình`
      : `${peer.fullName} đã trả lời bạn`;
  }, [hasReplyQuote, isMine, item.dto.senderPublicId, peer.fullName, replyTargetSenderPublicId]);

  const replyExcerptDisplay = isReplyTargetRecalled
    ? RECALLED_MESSAGE_PLACEHOLDER
    : item.replyTo?.textExcerpt?.trim() ||
      (item.dto.replyToMeta?.messageType === 'image'
        ? 'Hình ảnh'
        : item.dto.replyToMeta?.messageType === 'voice'
          ? 'Tin nhắn thoại'
          : 'Tin nhắn');

  const canClickReplyJump = Boolean(
    onJumpToMessage &&
    replyTargetPublicId &&
    !isReplyTargetRecalled &&
    !isReplyTargetDeletedForViewer,
  );

  // Gom danh sách emoji duy nhất để hiển thị viên thuốc gọn gàng bên dưới bong bóng.
  const uniqueReactionEmojis = React.useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const r of reactions) {
      if (!seen.has(r.emoji)) {
        seen.add(r.emoji);
        list.push(r.emoji);
      }
    }
    return list;
  }, [reactions]);

  const reactionTooltipText = React.useMemo(() => {
    if (reactions.length === 0) {
      return '';
    }
    const normMe = currentUserPublicId.toLowerCase();
    return reactions
      .map((r) => {
        const who = r.userPublicId.toLowerCase() === normMe ? 'Bạn' : peer.fullName;
        return `${r.emoji} ${who}`;
      })
      .join(' · ');
  }, [currentUserPublicId, peer.fullName, reactions]);

  if (item.dto.messageType === 'call_event' && !isRecalled) {
    const callMeta = item.dto.callEventMeta;
    const isMissedOrDeclined =
      callMeta?.status === 'missed' ||
      callMeta?.status === 'declined' ||
      callMeta?.status === 'busy';
    const isVideoCall = callMeta?.callType === 'video';
    const callLabel = formatCallEventLabel(callMeta);

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
          data-message-id={item.dto.public_id}
          className={cn(
            'group/msg flex items-center justify-center gap-1.5',
            isCompact ? 'my-2' : 'my-2.5',
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                tabIndex={0}
                onClick={() => onTapToggle?.(item.dto.clientMsgId)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border bg-muted/45 font-medium text-foreground shadow-2xs focus:outline-none',
                  isCompact ? 'px-3 py-1 text-[11px]' : 'px-3.5 py-1.5 text-xs',
                )}
              >
                <span
                  className={cn(
                    'inline-flex items-center justify-center rounded-full',
                    isCompact ? 'size-5' : 'size-6',
                    isMissedOrDeclined
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-primary/15 text-primary',
                  )}
                >
                  {isMissedOrDeclined ? (
                    <PhoneMissed className={isCompact ? 'size-3' : 'size-3.5'} aria-hidden="true" />
                  ) : isVideoCall ? (
                    <Video className={isCompact ? 'size-3' : 'size-3.5'} aria-hidden="true" />
                  ) : (
                    <Phone className={isCompact ? 'size-3' : 'size-3.5'} aria-hidden="true" />
                  )}
                </span>
                <span>{callLabel}</span>
              </div>
            </TooltipTrigger>
            {tooltipLabel ? <TooltipContent side="top">{tooltipLabel}</TooltipContent> : null}
          </Tooltip>

          {allowDeleteForMe ? (
            <div
              className={cn(
                'flex shrink-0 items-center transition-opacity duration-150',
                menuOpen || isTapSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100',
              )}
            >
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Tùy chọn sự kiện cuộc gọi"
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
                <DropdownMenuContent align="center" sideOffset={4}>
                  <DropdownMenuItem
                    onSelect={() => onDeleteForMe(item)}
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    <span>Xóa ở phía bạn</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      </React.Fragment>
    );
  }

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
        data-message-id={item.dto.public_id}
        className={cn(
          'group/msg flex flex-col rounded-xl transition-colors duration-500',
          isMine ? 'items-end' : 'items-start',
          isHighlighted ? 'bg-primary/10 px-1.5 py-1' : null,
          index === 0 || timeDividerLabel
            ? 'mt-0.5'
            : isNewCluster
              ? isCompact
                ? 'mt-2.5'
                : 'mt-3'
              : 'mt-0.5',
          reactions.length > 0 ? 'mb-1.5' : null,
        )}
      >
        {/* Nhãn chuyển tiếp nhẹ nhàng phía trên bong bóng */}
        {isForwarded ? (
          <div
            className={cn(
              'mb-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground',
              isMine ? 'pr-1' : isCompact ? 'pl-8' : 'pl-9',
            )}
          >
            <Forward className="size-2.5" aria-hidden="true" />
            <span>Đã chuyển tiếp</span>
          </div>
        ) : null}

        {/* Thẻ trích dẫn tin nhắn gốc khi Trả lời */}
        {hasReplyQuote ? (
          <div
            className={cn(
              'mb-1 flex max-w-[78%] flex-col',
              isMine ? 'items-end pr-0.5' : isCompact ? 'items-start pl-8' : 'items-start pl-9',
            )}
          >
            <span className="mb-0.5 text-[10px] text-muted-foreground">{replyHeadingLabel}</span>
            <button
              type="button"
              disabled={!canClickReplyJump}
              onClick={() => {
                if (canClickReplyJump && replyTargetPublicId) {
                  onJumpToMessage?.(replyTargetPublicId);
                }
              }}
              className={cn(
                'max-w-full rounded-xl border border-border/70 bg-muted/45 px-2.5 py-1 text-left transition-colors',
                isCompact ? 'text-[11px]' : 'text-xs',
                canClickReplyJump
                  ? 'cursor-pointer hover:bg-muted/80'
                  : 'cursor-default opacity-80',
                isReplyTargetRecalled ? 'italic text-muted-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="line-clamp-2 break-words">{replyExcerptDisplay}</span>
            </button>
          </div>
        ) : null}

        <div
          className={cn(
            'flex items-end',
            isCompact ? 'max-w-[92%] gap-1.5' : 'max-w-[85%] gap-2',
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

          <div
            className={cn('relative flex min-w-0 flex-col', isMine ? 'items-end' : 'items-start')}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  onClick={() => onTapToggle?.(item.dto.clientMsgId)}
                  className={cn(
                    'min-w-0 leading-relaxed break-words whitespace-pre-wrap transition-all focus:outline-none',
                    !isRecalled && item.dto.messageType === 'image' && !item.decryptionFailed
                      ? 'max-w-full overflow-hidden border border-border/60 p-0 shadow-2xs'
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
                    isBeingEdited || isHighlighted
                      ? 'ring-2 ring-primary/60 ring-offset-1 ring-offset-background'
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

            {/* Viên thuốc cảm xúc đặt ngay dưới bong bóng */}
            {reactions.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      myReaction
                        ? `Cảm xúc tin nhắn (${reactionTooltipText}). Nhấn để gỡ cảm xúc của bạn.`
                        : `Cảm xúc tin nhắn (${reactionTooltipText})`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!allowReact) {
                        return;
                      }
                      if (myReaction) {
                        onReact?.(item, null);
                      } else {
                        setReactionAnchorEl(event.currentTarget);
                        setReactionPickerOpen(true);
                      }
                    }}
                    className={cn(
                      '-mt-1.5 z-10 inline-flex items-center gap-0.5 rounded-full border bg-background px-1.5 py-0.5 text-xs shadow-xs transition-transform hover:scale-105',
                      myReaction ? 'border-primary/40 ring-1 ring-primary/20' : 'border-border/80',
                      isMine ? 'mr-1' : 'ml-1',
                    )}
                  >
                    {uniqueReactionEmojis.map((emoji) => (
                      <span key={emoji} className="leading-none">
                        {emoji}
                      </span>
                    ))}
                    {reactions.length > 1 ? (
                      <span className="pl-0.5 text-[10px] font-semibold text-muted-foreground">
                        {reactions.length}
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                {reactionTooltipText ? (
                  <TooltipContent side="bottom">{reactionTooltipText}</TooltipContent>
                ) : null}
              </Tooltip>
            ) : null}
          </div>

          {/* Cụm 3 nút tương tác phong cách Instagram (Cảm xúc · Trả lời · ⋮) */}
          {hasAnyQuickAction ? (
            <div
              className={cn(
                'relative z-10 flex shrink-0 items-center gap-0.5 self-center transition-opacity duration-150',
                menuOpen || reactionPickerOpen || isTapSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100',
              )}
            >
              {allowReact ? (
                <button
                  type="button"
                  aria-label="Thả cảm xúc"
                  title="Thả cảm xúc"
                  onClick={(event) => {
                    event.stopPropagation();
                    setReactionAnchorEl(event.currentTarget);
                    setReactionPickerOpen((prev) => !prev);
                  }}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isCompact ? 'size-6' : 'size-7',
                    reactionPickerOpen ? 'bg-muted text-foreground' : null,
                  )}
                >
                  <Smile className={cn(isCompact ? 'size-3.5' : 'size-4')} aria-hidden="true" />
                </button>
              ) : null}

              {allowReply ? (
                <button
                  type="button"
                  aria-label="Trả lời tin nhắn"
                  title="Trả lời"
                  onClick={(event) => {
                    event.stopPropagation();
                    onReply?.(item);
                  }}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isCompact ? 'size-6' : 'size-7',
                  )}
                >
                  <Reply className={cn(isCompact ? 'size-3.5' : 'size-4')} aria-hidden="true" />
                </button>
              ) : null}

              {hasAnyMenuAction ? (
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
                      title="Thêm"
                      onClick={(event) => event.stopPropagation()}
                      className={cn(
                        'inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isCompact ? 'size-6' : 'size-7',
                      )}
                    >
                      <MoreVertical
                        className={cn(isCompact ? 'size-3.5' : 'size-4')}
                        aria-hidden="true"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align={isMine ? 'end' : 'start'} sideOffset={4}>
                    {menuHeaderTime ? (
                      <>
                        <div className="px-2 py-1 text-[11px] font-normal text-muted-foreground">
                          {menuHeaderTime}
                        </div>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}

                    {allowForward ? (
                      <DropdownMenuItem onSelect={() => onForward?.(item)}>
                        <Forward className="size-3.5" aria-hidden="true" />
                        <span>Chuyển tiếp</span>
                      </DropdownMenuItem>
                    ) : null}

                    {allowCopy ? (
                      <DropdownMenuItem onSelect={() => onCopy?.(item)}>
                        <Copy className="size-3.5" aria-hidden="true" />
                        <span>Sao chép</span>
                      </DropdownMenuItem>
                    ) : null}

                    {allowPin ? (
                      <DropdownMenuItem onSelect={() => onTogglePin?.(item)}>
                        {isPinned ? (
                          <>
                            <PinOff className="size-3.5" aria-hidden="true" />
                            <span>Bỏ ghim</span>
                          </>
                        ) : (
                          <>
                            <Pin className="size-3.5" aria-hidden="true" />
                            <span>Ghim</span>
                          </>
                        )}
                      </DropdownMenuItem>
                    ) : null}

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
                      <>
                        {allowForward || allowCopy || allowPin || allowEdit || allowRecall ? (
                          <DropdownMenuSeparator />
                        ) : null}
                        <DropdownMenuItem
                          onSelect={() => onDeleteForMe(item)}
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          <span>Xóa ở phía bạn</span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Trạng thái đã ghim / đã chỉnh sửa */}
        {isPinned || isEdited ? (
          <div
            className={cn(
              'mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground',
              isMine ? 'px-1' : isCompact ? 'pl-8' : 'pl-9',
            )}
          >
            {isPinned ? (
              <span className="inline-flex items-center gap-0.5 font-medium text-primary/90">
                <Pin className="size-2.5" aria-hidden="true" />
                <span>Đã ghim</span>
              </span>
            ) : null}
            {isEdited ? <span>Đã chỉnh sửa</span> : null}
          </div>
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

        {allowReact ? (
          <MessageReactionPicker
            open={reactionPickerOpen}
            anchorEl={reactionAnchorEl}
            activeEmoji={myReaction}
            onSelectEmoji={(emoji) => onReact?.(item, emoji)}
            onClose={() => setReactionPickerOpen(false)}
          />
        ) : null}
      </div>
    </React.Fragment>
  );
});
