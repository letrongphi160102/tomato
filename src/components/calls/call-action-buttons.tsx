'use client';

import * as React from 'react';
import { Phone, Video } from 'lucide-react';

import { useCall } from '@/components/calls/call-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConversationSummaryDto } from '@/modules/chat';

export interface CallActionButtonsProps {
  readonly conversation: ConversationSummaryDto;
  readonly compact?: boolean;
}

/**
 * Nút Gọi thoại & Gọi video dùng chung cho cả thanh tiêu đề `/messages` và `FloatingMessagesWidget`.
 * Tự động ẩn hoàn toàn khi hội thoại đang ở trạng thái Tin nhắn đang chờ (`!conversation.canSendMedia`).
 */
export function CallActionButtons({ conversation, compact = false }: CallActionButtonsProps) {
  const call = useCall();

  if (!call || !conversation.canSendMedia) {
    return null;
  }

  const disabled = call.isBusyInCall;
  const btnSizeClass = compact ? 'size-8' : 'size-9';
  const iconSizeClass = compact ? 'size-3.5' : 'size-4.5';

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={`Gọi thoại cho ${conversation.peer.fullName}`}
        title={disabled ? 'Bạn đang trong một cuộc gọi khác' : 'Gọi thoại'}
        onClick={() => void call.startCall(conversation, 'audio')}
        className={cn(
          btnSizeClass,
          'rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40',
        )}
      >
        <Phone className={iconSizeClass} aria-hidden="true" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={`Gọi video cho ${conversation.peer.fullName}`}
        title={disabled ? 'Bạn đang trong một cuộc gọi khác' : 'Gọi video'}
        onClick={() => void call.startCall(conversation, 'video')}
        className={cn(
          btnSizeClass,
          'rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40',
        )}
      >
        <Video className={iconSizeClass} aria-hidden="true" />
      </Button>
    </div>
  );
}
