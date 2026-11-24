'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { ActiveCallScreen } from '@/components/calls/active-call-screen';
import { useCall } from '@/components/calls/call-context';
import { IncomingCallDialog } from '@/components/calls/incoming-call-dialog';

const EMPTY_SUBSCRIBE = () => () => undefined;

export function GlobalCallOverlay() {
  const call = useCall();
  const mounted = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );

  if (!call) {
    return null;
  }

  const showFloatingNotice =
    mounted &&
    typeof document !== 'undefined' &&
    call.phase === 'idle' &&
    Boolean(call.noticeMessage);

  return (
    <>
      {call.phase === 'incoming_ringing' && call.incomingCall ? (
        <IncomingCallDialog
          incomingCall={call.incomingCall}
          onAccept={() => void call.acceptIncomingCall()}
          onDecline={() => void call.declineIncomingCall()}
        />
      ) : null}

      {call.activeCall &&
      (call.phase === 'starting' ||
        call.phase === 'outgoing_ringing' ||
        call.phase === 'connecting' ||
        call.phase === 'connected') ? (
        <ActiveCallScreen
          phase={call.phase}
          activeCall={call.activeCall}
          localStream={call.localStream}
          remoteStream={call.remoteStream}
          isMicMuted={call.isMicMuted}
          isCameraEnabled={call.isCameraEnabled}
          durationSeconds={call.durationSeconds}
          noticeMessage={call.noticeMessage}
          onToggleMicrophone={call.toggleMicrophone}
          onToggleCamera={() => void call.toggleCamera()}
          onEndCall={() => void call.endActiveCall()}
        />
      ) : null}

      {showFloatingNotice
        ? createPortal(
            <div
              role="status"
              aria-live="polite"
              className="fixed top-16 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 items-center justify-between gap-3 rounded-2xl border bg-background/95 px-4 py-3 text-sm text-foreground shadow-xl backdrop-blur"
            >
              <span className="leading-snug">{call.noticeMessage}</span>
              <button
                type="button"
                aria-label="Đóng thông báo"
                onClick={call.dismissNotice}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
