'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Phone, PhoneOff, Video } from 'lucide-react';

import type { IncomingCallSessionUi } from '@/components/calls/call-context';
import { UserAvatar } from '@/components/profile/user-avatar';
import { Button } from '@/components/ui/button';

export interface IncomingCallDialogProps {
  readonly incomingCall: IncomingCallSessionUi;
  readonly busy?: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

const EMPTY_SUBSCRIBE = () => () => undefined;

export function IncomingCallDialog({
  incomingCall,
  busy = false,
  onAccept,
  onDecline,
}: IncomingCallDialogProps) {
  const mounted = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  const isVideo = incomingCall.callType === 'video';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-xs overflow-hidden rounded-3xl border bg-background p-6 text-center shadow-2xl">
        <div className="relative mx-auto flex size-24 items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-ping rounded-full bg-primary/20"
          />
          <UserAvatar
            fullName={incomingCall.caller.fullName}
            avatarUrl={incomingCall.caller.avatarUrl}
            size="xl"
            className="relative size-20 ring-4 ring-background"
          />
        </div>

        <h2 className="mt-4 truncate text-lg font-bold text-foreground">
          {incomingCall.caller.fullName}
        </h2>
        <p className="truncate text-xs text-muted-foreground">@{incomingCall.caller.handle}</p>

        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
          {isVideo ? (
            <Video className="size-3.5 text-primary" aria-hidden="true" />
          ) : (
            <Phone className="size-3.5 text-primary" aria-hidden="true" />
          )}
          <span>{isVideo ? 'Cuộc gọi video đến...' : 'Cuộc gọi thoại đến...'}</span>
        </div>

        <div className="mt-7 flex items-center justify-center gap-8">
          <div className="flex flex-col items-center gap-1.5">
            <Button
              type="button"
              size="icon"
              disabled={busy}
              aria-label="Từ chối cuộc gọi"
              onClick={onDecline}
              className="size-14 rounded-full bg-destructive text-destructive-foreground shadow-lg hover:bg-destructive/90"
            >
              <PhoneOff className="size-6" aria-hidden="true" />
            </Button>
            <span className="text-xs font-medium text-muted-foreground">Từ chối</span>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <Button
              type="button"
              size="icon"
              disabled={busy}
              aria-label="Trả lời cuộc gọi"
              onClick={onAccept}
              className="size-14 rounded-full bg-emerald-600 text-white shadow-lg hover:bg-emerald-500"
            >
              {isVideo ? (
                <Video className="size-6" aria-hidden="true" />
              ) : (
                <Phone className="size-6" aria-hidden="true" />
              )}
            </Button>
            <span className="text-xs font-medium text-foreground">Trả lời</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
