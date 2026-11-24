import * as React from 'react';

import type { CallType } from '@/core/db/schema/enums';
import type { CallPeerDto } from '@/modules/calls/call-signaling.service';
import type { ConversationSummaryDto } from '@/modules/chat';

export type CallUiPhase =
  'idle' | 'starting' | 'outgoing_ringing' | 'incoming_ringing' | 'connecting' | 'connected';

export interface ActiveCallSessionUi {
  readonly callPublicId: string;
  readonly conversationPublicId: string;
  readonly callType: CallType;
  readonly isCaller: boolean;
  readonly peer: CallPeerDto;
  readonly startedAtIso: string;
  readonly connectedAtMs: number | null;
}

export interface IncomingCallSessionUi {
  readonly callPublicId: string;
  readonly conversationPublicId: string;
  readonly callType: CallType;
  readonly caller: CallPeerDto;
  readonly startedAtIso: string;
  readonly expiresAtIso: string;
}

export interface CallContextValue {
  readonly phase: CallUiPhase;
  readonly activeCall: ActiveCallSessionUi | null;
  readonly incomingCall: IncomingCallSessionUi | null;
  readonly localStream: MediaStream | null;
  readonly remoteStream: MediaStream | null;
  readonly isMicMuted: boolean;
  readonly isCameraEnabled: boolean;
  readonly durationSeconds: number;
  readonly noticeMessage: string | null;
  readonly isBusyInCall: boolean;
  readonly startCall: (conversation: ConversationSummaryDto, callType: CallType) => Promise<void>;
  readonly acceptIncomingCall: () => Promise<void>;
  readonly declineIncomingCall: () => Promise<void>;
  readonly endActiveCall: () => Promise<void>;
  readonly toggleMicrophone: () => void;
  readonly toggleCamera: () => Promise<void>;
  readonly dismissNotice: () => void;
  readonly cleanupOnLogout: () => void;
}

export const CallContext = React.createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue | null {
  return React.useContext(CallContext);
}
