'use client';

import * as React from 'react';

import {
  CallContext,
  type ActiveCallSessionUi,
  type CallContextValue,
  type CallUiPhase,
  type IncomingCallSessionUi,
} from '@/components/calls/call-context';
import { GlobalCallOverlay } from '@/components/calls/global-call-overlay';
import { useRealtimePresence } from '@/components/realtime/realtime-presence-context';
import type { CallType } from '@/core/db/schema/enums';
import type { IceServerConfigDto, IceServersResponseDto } from '@/core/webrtc/types';
import { authFetch, getCsrfTokenFromDocumentCookie } from '@/lib/auth-client';
import {
  PeerCallEngine,
  acquireLocalCallMediaStream,
  createCallRingtoneController,
  stopAllMediaStreamTracks,
  type CallSignalPayload,
  type RingtoneController,
} from '@/lib/webrtc';
import type { CallPeerDto, CallSessionDto } from '@/modules/calls/call-signaling.service';
import type { ConversationSummaryDto } from '@/modules/chat';

const OUTGOING_RING_TIMEOUT_MS = 45_000;
const INCOMING_RING_SAFETY_TIMEOUT_MS = 46_500;
const CALL_HEARTBEAT_INTERVAL_MS = 30_000;
const NOTICE_AUTO_DISMISS_MS = 5_000;

const CLIENT_FALLBACK_STUN_SERVERS: readonly IceServerConfigDto[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface CallProviderProps {
  readonly currentUserPublicId: string;
  readonly children: React.ReactNode;
}

function parsePeerFromEvent(raw: unknown): CallPeerDto | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as Partial<CallPeerDto>;
  if (
    typeof obj.public_id !== 'string' ||
    typeof obj.handle !== 'string' ||
    typeof obj.fullName !== 'string'
  ) {
    return null;
  }
  return {
    public_id: obj.public_id,
    handle: obj.handle,
    fullName: obj.fullName,
    avatarUrl: typeof obj.avatarUrl === 'string' ? obj.avatarUrl : null,
  };
}

function parseSignalFromEvent(data: Record<string, unknown>): CallSignalPayload | null {
  const signalType = data.type;
  if ((signalType === 'offer' || signalType === 'answer') && typeof data.sdp === 'string') {
    return { type: signalType, sdp: data.sdp };
  }
  if (signalType === 'ice-candidate' && typeof data.candidate === 'string') {
    return {
      type: 'ice-candidate',
      candidate: data.candidate,
      sdpMid: typeof data.sdpMid === 'string' ? data.sdpMid : null,
      sdpMLineIndex: typeof data.sdpMLineIndex === 'number' ? data.sdpMLineIndex : null,
      usernameFragment: typeof data.usernameFragment === 'string' ? data.usernameFragment : null,
    };
  }
  return null;
}

export function CallProvider({ currentUserPublicId, children }: CallProviderProps) {
  const realtime = useRealtimePresence();
  const subscribeCallEvents = realtime?.subscribeCallEvents;

  const [phase, setPhase] = React.useState<CallUiPhase>('idle');
  const [activeCall, setActiveCall] = React.useState<ActiveCallSessionUi | null>(null);
  const [incomingCall, setIncomingCall] = React.useState<IncomingCallSessionUi | null>(null);
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = React.useState<MediaStream | null>(null);
  const [isMicMuted, setIsMicMuted] = React.useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = React.useState(false);
  const [durationSeconds, setDurationSeconds] = React.useState(0);
  const [noticeMessage, setNoticeMessage] = React.useState<string | null>(null);

  const phaseRef = React.useRef<CallUiPhase>(phase);
  const activeCallRef = React.useRef<ActiveCallSessionUi | null>(activeCall);
  const incomingCallRef = React.useRef<IncomingCallSessionUi | null>(incomingCall);
  const engineRef = React.useRef<PeerCallEngine | null>(null);
  const earlySignalsByCallIdRef = React.useRef<Map<string, CallSignalPayload[]>>(new Map());
  const ringtoneRef = React.useRef<RingtoneController | null>(null);
  const ringTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const durationIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pagehideEndSentForCallIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  React.useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  React.useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  const showTransientNotice = React.useCallback((message: string) => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNoticeMessage(message);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNoticeMessage(null);
    }, NOTICE_AUTO_DISMISS_MS);
  }, []);

  const dismissNotice = React.useCallback(() => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNoticeMessage(null);
  }, []);

  const clearCallTimers = React.useCallback(() => {
    if (ringTimeoutRef.current !== null) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    if (heartbeatIntervalRef.current !== null) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (durationIntervalRef.current !== null) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const stopRingtone = React.useCallback(() => {
    ringtoneRef.current?.stop();
  }, []);

  const startRingtone = React.useCallback((mode: 'incoming' | 'outgoing') => {
    if (!ringtoneRef.current) {
      ringtoneRef.current = createCallRingtoneController();
    }
    ringtoneRef.current.start(mode);
  }, []);

  const teardownLocalCallResources = React.useCallback(
    (options?: { readonly notice?: string }) => {
      clearCallTimers();
      stopRingtone();

      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }

      earlySignalsByCallIdRef.current.clear();
      setActiveCall(null);
      setIncomingCall(null);
      setLocalStream(null);
      setRemoteStream(null);
      setIsMicMuted(false);
      setIsCameraEnabled(false);
      setDurationSeconds(0);
      setPhase('idle');

      if (options?.notice) {
        showTransientNotice(options.notice);
      }
    },
    [clearCallTimers, showTransientNotice, stopRingtone],
  );

  const sendCallActionApi = React.useCallback(
    async (
      callPublicId: string,
      action: 'accept' | 'decline' | 'end' | 'timeout' | 'heartbeat',
    ): Promise<Response | null> => {
      try {
        return await authFetch(`/api/v1/calls/${encodeURIComponent(callPublicId)}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
      } catch {
        return null;
      }
    },
    [],
  );

  const sendCallSignalApi = React.useCallback(
    async (callPublicId: string, signal: CallSignalPayload): Promise<void> => {
      try {
        await authFetch(`/api/v1/calls/${encodeURIComponent(callPublicId)}/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signal),
        });
      } catch {
        // Bỏ qua lỗi mạng tạm thời trong lúc trickle ICE.
      }
    },
    [],
  );

  const fetchIceServers = React.useCallback(async (): Promise<readonly IceServerConfigDto[]> => {
    try {
      const response = await authFetch('/api/v1/calls/ice-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        return CLIENT_FALLBACK_STUN_SERVERS;
      }
      const data = (await response.json()) as Partial<IceServersResponseDto>;
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers;
      }
      return CLIENT_FALLBACK_STUN_SERVERS;
    } catch {
      return CLIENT_FALLBACK_STUN_SERVERS;
    }
  }, []);

  const sendKeepaliveEndForCall = React.useCallback((callPublicId: string) => {
    if (!callPublicId || pagehideEndSentForCallIdRef.current === callPublicId) {
      return;
    }
    pagehideEndSentForCallIdRef.current = callPublicId;

    const csrfToken = getCsrfTokenFromDocumentCookie();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    try {
      void fetch(`/api/v1/calls/${encodeURIComponent(callPublicId)}/action`, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers,
        body: JSON.stringify({ action: 'end' }),
      }).catch(() => undefined);
    } catch {
      // Bỏ qua khi trang đang đóng.
    }
  }, []);

  const createConfiguredEngine = React.useCallback(
    (callPublicId: string, isCaller: boolean): PeerCallEngine => {
      if (engineRef.current) {
        engineRef.current.destroy();
      }
      const engine = new PeerCallEngine({
        isCaller,
        callbacks: {
          onSendSignal: async (signal) => {
            await sendCallSignalApi(callPublicId, signal);
          },
          onLocalStreamChanged: (stream) => {
            setLocalStream(stream);
          },
          onRemoteStreamChanged: (stream) => {
            setRemoteStream(stream);
          },
          onConnectionStateChanged: (state) => {
            if (state === 'connected') {
              setPhase('connected');
              setActiveCall((prev) =>
                prev && prev.connectedAtMs === null ? { ...prev, connectedAtMs: Date.now() } : prev,
              );
            } else if (state === 'failed') {
              const current = activeCallRef.current;
              if (current && current.callPublicId === callPublicId) {
                void sendCallActionApi(callPublicId, 'end');
                teardownLocalCallResources({
                  notice: 'Kết nối cuộc gọi bị gián đoạn. Vui lòng thử gọi lại.',
                });
              }
            }
          },
          onMediaNotice: (message) => {
            showTransientNotice(message);
          },
        },
      });
      engineRef.current = engine;
      return engine;
    },
    [sendCallActionApi, sendCallSignalApi, showTransientNotice, teardownLocalCallResources],
  );

  // =========================================================================
  // 1. Bắt đầu cuộc gọi mới (Caller)
  // =========================================================================

  const startCall = React.useCallback(
    async (conversation: ConversationSummaryDto, callType: CallType) => {
      if (phaseRef.current !== 'idle' || !conversation.canSendMedia) {
        return;
      }

      dismissNotice();
      setPhase('starting');

      let acquiredStream: MediaStream | null = null;
      let hasVideo = false;
      try {
        const media = await acquireLocalCallMediaStream(callType === 'video');
        acquiredStream = media.stream;
        hasVideo = media.hasVideo;
        if (media.notice) {
          showTransientNotice(media.notice);
        }
      } catch (error) {
        setPhase('idle');
        showTransientNotice(
          error instanceof Error ? error.message : 'Không thể truy cập micro hoặc camera.',
        );
        return;
      }

      try {
        const response = await authFetch('/api/v1/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationPublicId: conversation.public_id,
            callType,
          }),
        });

        if (!response.ok) {
          stopAllMediaStreamTracks(acquiredStream);
          setPhase('idle');
          const errBody = (await response.json().catch(() => null)) as {
            readonly error?: { readonly message?: string };
          } | null;
          showTransientNotice(
            errBody?.error?.message ?? 'Không thể bắt đầu cuộc gọi lúc này. Vui lòng thử lại.',
          );
          return;
        }

        const data = (await response.json()) as { readonly call: CallSessionDto };
        const session = data.call;
        pagehideEndSentForCallIdRef.current = null;

        const engine = createConfiguredEngine(session.public_id, true);
        engine.setLocalStream(acquiredStream);
        setIsMicMuted(false);
        setIsCameraEnabled(hasVideo);

        setActiveCall({
          callPublicId: session.public_id,
          conversationPublicId: session.conversationPublicId,
          callType: session.callType,
          isCaller: true,
          peer: session.peer,
          startedAtIso: session.startedAt,
          connectedAtMs: null,
        });
        setPhase('outgoing_ringing');
        startRingtone('outgoing');

        // Nạp sẵn ICE/TURN ngắn hạn song song lúc đang đổ chuông để kết nối nhanh khi đối phương nhấc máy.
        const iceServers = await fetchIceServers();
        if (
          engineRef.current === engine &&
          activeCallRef.current?.callPublicId === session.public_id
        ) {
          engine.initializePeerConnection(iceServers);
          const buffered = earlySignalsByCallIdRef.current.get(session.public_id) ?? [];
          earlySignalsByCallIdRef.current.delete(session.public_id);
          for (const sig of buffered) {
            await engine.handleRemoteSignal(sig);
          }
          await engine.flushPendingSignalsAfterInit();
        }

        // Hẹn giờ 45 giây nếu đối phương không bắt máy -> gửi `timeout` (`missed`) và giải phóng tài nguyên.
        ringTimeoutRef.current = setTimeout(() => {
          if (
            activeCallRef.current?.callPublicId === session.public_id &&
            phaseRef.current === 'outgoing_ringing'
          ) {
            void sendCallActionApi(session.public_id, 'timeout');
            teardownLocalCallResources({ notice: 'Không có phản hồi.' });
          }
        }, OUTGOING_RING_TIMEOUT_MS);
      } catch {
        stopAllMediaStreamTracks(acquiredStream);
        teardownLocalCallResources({
          notice: 'Không thể kết nối máy chủ cuộc gọi. Vui lòng thử lại.',
        });
      }
    },
    [
      createConfiguredEngine,
      dismissNotice,
      fetchIceServers,
      sendCallActionApi,
      showTransientNotice,
      startRingtone,
      teardownLocalCallResources,
    ],
  );

  // =========================================================================
  // 2. Trả lời / Từ chối / Kết thúc cuộc gọi
  // =========================================================================

  const acceptIncomingCall = React.useCallback(async () => {
    const incoming = incomingCallRef.current;
    if (!incoming || phaseRef.current !== 'incoming_ringing') {
      return;
    }

    stopRingtone();
    clearCallTimers();
    dismissNotice();
    setPhase('connecting');

    let acquiredStream: MediaStream | null = null;
    let hasVideo = false;
    try {
      const media = await acquireLocalCallMediaStream(incoming.callType === 'video');
      acquiredStream = media.stream;
      hasVideo = media.hasVideo;
      if (media.notice) {
        showTransientNotice(media.notice);
      }
    } catch (error) {
      void sendCallActionApi(incoming.callPublicId, 'decline');
      teardownLocalCallResources({
        notice:
          error instanceof Error
            ? error.message
            : 'Không thể truy cập micro hoặc camera để trả lời.',
      });
      return;
    }

    const callId = incoming.callPublicId;
    pagehideEndSentForCallIdRef.current = null;

    const engine = createConfiguredEngine(callId, false);
    engine.setLocalStream(acquiredStream);
    setIsMicMuted(false);
    setIsCameraEnabled(hasVideo);
    setIncomingCall(null);
    setActiveCall({
      callPublicId: callId,
      conversationPublicId: incoming.conversationPublicId,
      callType: incoming.callType,
      isCaller: false,
      peer: incoming.caller,
      startedAtIso: incoming.startedAtIso,
      connectedAtMs: Date.now(),
    });

    const iceServers = await fetchIceServers();
    if (engineRef.current !== engine) {
      return;
    }
    engine.initializePeerConnection(iceServers);

    // Chuyển toàn bộ offer/ICE đã đệm sớm trước khi bấm Trả lời vào engine để xả đúng thứ tự.
    const buffered = earlySignalsByCallIdRef.current.get(callId) ?? [];
    earlySignalsByCallIdRef.current.delete(callId);
    for (const sig of buffered) {
      await engine.handleRemoteSignal(sig);
    }

    const acceptRes = await sendCallActionApi(callId, 'accept');
    if (!acceptRes || !acceptRes.ok) {
      const errBody = (await acceptRes?.json().catch(() => null)) as {
        readonly error?: { readonly message?: string };
      } | null;
      teardownLocalCallResources({
        notice: errBody?.error?.message ?? 'Cuộc gọi đã kết thúc.',
      });
      return;
    }

    await engine.flushPendingSignalsAfterInit();
    setPhase('connected');
  }, [
    clearCallTimers,
    createConfiguredEngine,
    dismissNotice,
    fetchIceServers,
    sendCallActionApi,
    showTransientNotice,
    stopRingtone,
    teardownLocalCallResources,
  ]);

  const declineIncomingCall = React.useCallback(async () => {
    const incoming = incomingCallRef.current;
    if (!incoming) {
      return;
    }
    const callId = incoming.callPublicId;
    teardownLocalCallResources();
    await sendCallActionApi(callId, 'decline');
  }, [sendCallActionApi, teardownLocalCallResources]);

  const endActiveCall = React.useCallback(async () => {
    const current = activeCallRef.current;
    const incoming = incomingCallRef.current;
    const callId = current?.callPublicId ?? incoming?.callPublicId ?? null;
    const action = incoming && !current ? 'decline' : 'end';
    teardownLocalCallResources();
    if (callId) {
      pagehideEndSentForCallIdRef.current = callId;
      await sendCallActionApi(callId, action);
    }
  }, [sendCallActionApi, teardownLocalCallResources]);

  const toggleMicrophone = React.useCallback(() => {
    setIsMicMuted((prev) => {
      const next = !prev;
      engineRef.current?.setMicrophoneMuted(next);
      return next;
    });
  }, []);

  const toggleCamera = React.useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    const nextEnable = !isCameraEnabled;
    const result = await engine.setCameraEnabled(nextEnable);
    setIsCameraEnabled(result.enabled);
    if (result.errorMessage) {
      showTransientNotice(result.errorMessage);
    }
  }, [isCameraEnabled, showTransientNotice]);

  const cleanupOnLogout = React.useCallback(() => {
    const currentId = activeCallRef.current?.callPublicId ?? incomingCallRef.current?.callPublicId;
    if (currentId) {
      sendKeepaliveEndForCall(currentId);
    }
    teardownLocalCallResources();
  }, [sendKeepaliveEndForCall, teardownLocalCallResources]);

  // =========================================================================
  // 3. Nhịp Heartbeat 30 giây (`connected`) & Bộ đếm thời gian cuộc gọi
  // =========================================================================

  React.useEffect(() => {
    if (phase !== 'connected' || !activeCall) {
      if (heartbeatIntervalRef.current !== null) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (durationIntervalRef.current !== null) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      return;
    }

    const callId = activeCall.callPublicId;
    const startedMs = activeCall.connectedAtMs ?? Date.now();

    durationIntervalRef.current = setInterval(() => {
      setDurationSeconds(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
    }, 1_000);

    heartbeatIntervalRef.current = setInterval(() => {
      if (activeCallRef.current?.callPublicId === callId && phaseRef.current === 'connected') {
        void sendCallActionApi(callId, 'heartbeat');
      }
    }, CALL_HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatIntervalRef.current !== null) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (durationIntervalRef.current !== null) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    };
  }, [activeCall, phase, sendCallActionApi]);

  // =========================================================================
  // 4. Đóng tab / mất trang đột ngột (`pagehide`) -> gửi `action: 'end'` bằng `keepalive: true`
  // =========================================================================

  React.useEffect(() => {
    const handlePageHide = () => {
      const current = activeCallRef.current;
      if (current) {
        sendKeepaliveEndForCall(current.callPublicId);
      }
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
      stopRingtone();
    };

    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [sendKeepaliveEndForCall, stopRingtone]);

  // Dọn tài nguyên khi unmount hoặc đổi tài khoản.
  React.useEffect(() => {
    return () => {
      teardownLocalCallResources();
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, [currentUserPublicId, teardownLocalCallResources]);

  // =========================================================================
  // 5. Lắng nghe Sự kiện Cuộc gọi Toàn cục từ `RealtimePresenceProvider`
  // =========================================================================

  React.useEffect(() => {
    if (!subscribeCallEvents) {
      return;
    }

    return subscribeCallEvents((event) => {
      const callPublicId =
        typeof event.data.callPublicId === 'string' ? event.data.callPublicId : null;
      if (!callPublicId) {
        return;
      }

      if (event.event === 'call.incoming') {
        const caller = parsePeerFromEvent(event.data.caller);
        const conversationPublicId =
          typeof event.data.conversationPublicId === 'string'
            ? event.data.conversationPublicId
            : null;
        const callType = event.data.callType === 'video' ? 'video' : 'audio';
        const startedAtIso =
          typeof event.data.startedAt === 'string'
            ? event.data.startedAt
            : new Date().toISOString();
        const expiresAtIso =
          typeof event.data.expiresAt === 'string'
            ? event.data.expiresAt
            : new Date(Date.now() + OUTGOING_RING_TIMEOUT_MS).toISOString();

        if (!caller || !conversationPublicId) {
          return;
        }
        // Nếu đang ở trong một cuộc gọi khác -> bỏ qua để không ghi đè UI.
        if (phaseRef.current !== 'idle') {
          return;
        }

        setIncomingCall({
          callPublicId,
          conversationPublicId,
          callType,
          caller,
          startedAtIso,
          expiresAtIso,
        });
        setPhase('incoming_ringing');
        startRingtone('incoming');

        // Hẹn giờ an toàn 46.5 giây phòng trường hợp tab của người gọi đóng đột ngột.
        ringTimeoutRef.current = setTimeout(() => {
          if (incomingCallRef.current?.callPublicId === callPublicId) {
            void sendCallActionApi(callPublicId, 'timeout');
            teardownLocalCallResources();
          }
        }, INCOMING_RING_SAFETY_TIMEOUT_MS);
        return;
      }

      if (event.event === 'call.accepted') {
        // Nếu tab khác của chính người nhận vừa bấm Trả lời -> tự ẩn hộp thoại cuộc gọi đến ở tab này.
        if (incomingCallRef.current?.callPublicId === callPublicId) {
          teardownLocalCallResources();
          return;
        }

        // Phía người gọi nhận tín hiệu đối phương vừa nhấc máy -> gửi SDP Offer!
        const current = activeCallRef.current;
        if (current && current.callPublicId === callPublicId && current.isCaller) {
          stopRingtone();
          if (ringTimeoutRef.current !== null) {
            clearTimeout(ringTimeoutRef.current);
            ringTimeoutRef.current = null;
          }
          setPhase('connecting');
          setActiveCall((prev) =>
            prev ? { ...prev, connectedAtMs: prev.connectedAtMs ?? Date.now() } : prev,
          );

          void (async () => {
            const engine = engineRef.current;
            if (!engine) {
              return;
            }
            if (!engine.isInitialized()) {
              const servers = await fetchIceServers();
              if (engineRef.current !== engine) {
                return;
              }
              engine.initializePeerConnection(servers);
            }
            await engine.createAndSendOffer();
          })();
        }
        return;
      }

      if (event.event === 'call.signal') {
        const signal = parseSignalFromEvent(event.data);
        if (!signal) {
          return;
        }

        const current = activeCallRef.current;
        const incoming = incomingCallRef.current;

        if (current && current.callPublicId === callPublicId && engineRef.current) {
          void engineRef.current.handleRemoteSignal(signal);
          return;
        }

        // Đệm sớm toàn bộ `offer` và `ice-candidate` khi đang `incoming_ringing` hoặc chưa khởi tạo engine xong.
        if (
          (incoming && incoming.callPublicId === callPublicId) ||
          (current && current.callPublicId === callPublicId)
        ) {
          const existing = earlySignalsByCallIdRef.current.get(callPublicId) ?? [];
          existing.push(signal);
          earlySignalsByCallIdRef.current.set(callPublicId, existing);
        }
        return;
      }

      if (event.event === 'call.declined') {
        const matchesCurrent = activeCallRef.current?.callPublicId === callPublicId;
        const matchesIncoming = incomingCallRef.current?.callPublicId === callPublicId;
        if (matchesCurrent) {
          teardownLocalCallResources({ notice: 'Người nhận đã từ chối cuộc gọi.' });
        } else if (matchesIncoming) {
          teardownLocalCallResources();
        }
        return;
      }

      if (event.event === 'call.ended') {
        const matchesCurrent = activeCallRef.current?.callPublicId === callPublicId;
        const matchesIncoming = incomingCallRef.current?.callPublicId === callPublicId;
        if (matchesCurrent) {
          const status = event.data.status;
          const notice = status === 'missed' ? 'Cuộc gọi nhỡ.' : 'Cuộc gọi đã kết thúc.';
          teardownLocalCallResources({ notice });
        } else if (matchesIncoming) {
          teardownLocalCallResources();
        }
      }
    });
  }, [
    fetchIceServers,
    sendCallActionApi,
    startRingtone,
    stopRingtone,
    subscribeCallEvents,
    teardownLocalCallResources,
  ]);

  const contextValue = React.useMemo<CallContextValue>(
    () => ({
      phase,
      activeCall,
      incomingCall,
      localStream,
      remoteStream,
      isMicMuted,
      isCameraEnabled,
      durationSeconds,
      noticeMessage,
      isBusyInCall: phase !== 'idle',
      startCall,
      acceptIncomingCall,
      declineIncomingCall,
      endActiveCall,
      toggleMicrophone,
      toggleCamera,
      dismissNotice,
      cleanupOnLogout,
    }),
    [
      acceptIncomingCall,
      activeCall,
      cleanupOnLogout,
      declineIncomingCall,
      dismissNotice,
      durationSeconds,
      endActiveCall,
      incomingCall,
      isCameraEnabled,
      isMicMuted,
      localStream,
      noticeMessage,
      phase,
      remoteStream,
      startCall,
      toggleCamera,
      toggleMicrophone,
    ],
  );

  return (
    <CallContext.Provider value={contextValue}>
      {children}
      <GlobalCallOverlay />
    </CallContext.Provider>
  );
}
