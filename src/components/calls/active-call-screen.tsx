'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';

import type { ActiveCallSessionUi, CallUiPhase } from '@/components/calls/call-context';
import { UserAvatar } from '@/components/profile/user-avatar';
import { cn } from '@/lib/utils';

type PipCorner = 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';

const PIP_CORNER_ORDER: readonly PipCorner[] = [
  'bottom-right',
  'bottom-left',
  'top-left',
  'top-right',
];

const PIP_CORNER_CLASS: Readonly<Record<PipCorner, string>> = {
  'bottom-right': 'right-4 bottom-28 sm:right-6 sm:bottom-28',
  'bottom-left': 'left-4 bottom-28 sm:left-6 sm:bottom-28',
  'top-left': 'left-4 top-20 sm:left-6 sm:top-20',
  'top-right': 'right-4 top-20 sm:right-6 sm:top-20',
};

const EMPTY_SUBSCRIBE = () => () => undefined;

function formatCallDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export interface ActiveCallScreenProps {
  readonly phase: CallUiPhase;
  readonly activeCall: ActiveCallSessionUi;
  readonly localStream: MediaStream | null;
  readonly remoteStream: MediaStream | null;
  readonly isMicMuted: boolean;
  readonly isCameraEnabled: boolean;
  readonly durationSeconds: number;
  readonly noticeMessage: string | null;
  readonly onToggleMicrophone: () => void;
  readonly onToggleCamera: () => void;
  readonly onEndCall: () => void;
}

export function ActiveCallScreen({
  phase,
  activeCall,
  localStream,
  remoteStream,
  isMicMuted,
  isCameraEnabled,
  durationSeconds,
  noticeMessage,
  onToggleMicrophone,
  onToggleCamera,
  onEndCall,
}: ActiveCallScreenProps) {
  const mounted = React.useSyncExternalStore(
    EMPTY_SUBSCRIBE,
    () => true,
    () => false,
  );
  const [pipCornerIdx, setPipCornerIdx] = React.useState(0);
  const [remoteVideoTrackState, setRemoteVideoTrackState] = React.useState<{
    readonly stream: MediaStream;
    readonly live: boolean;
  } | null>(null);

  const remoteAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const localVideoRef = React.useRef<HTMLVideoElement | null>(null);

  const remoteVideoTrackLive =
    remoteStream !== null &&
    (remoteVideoTrackState?.stream === remoteStream
      ? remoteVideoTrackState.live
      : remoteStream
          .getVideoTracks()
          .some((t) => t.readyState === 'live' && !t.muted && t.enabled));

  // Gắn luồng âm thanh đối phương vào phần tử `<audio>` riêng để phát ổn định ngay cả khi đối phương tắt camera.
  React.useEffect(() => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) {
      return;
    }
    audioEl.srcObject = remoteStream;
    if (remoteStream) {
      void audioEl.play().catch(() => undefined);
    }
    return () => {
      audioEl.srcObject = null;
    };
  }, [remoteStream]);

  // Theo dõi trạng thái video track của đối phương (live / mute / unmute / ended) để tự chuyển giữa video và avatar.
  React.useEffect(() => {
    const videoEl = remoteVideoRef.current;
    if (videoEl) {
      videoEl.srcObject = remoteStream;
      if (remoteStream) {
        void videoEl.play().catch(() => undefined);
      }
    }

    if (!remoteStream) {
      return;
    }

    const evaluateRemoteVideo = () => {
      const tracks = remoteStream.getVideoTracks();
      const hasLive = tracks.some((t) => t.readyState === 'live' && !t.muted && t.enabled);
      setRemoteVideoTrackState({ stream: remoteStream, live: hasLive });
    };

    const videoTracks = remoteStream.getVideoTracks();
    for (const track of videoTracks) {
      track.addEventListener('mute', evaluateRemoteVideo);
      track.addEventListener('unmute', evaluateRemoteVideo);
      track.addEventListener('ended', evaluateRemoteVideo);
    }
    remoteStream.addEventListener('addtrack', evaluateRemoteVideo);
    remoteStream.addEventListener('removetrack', evaluateRemoteVideo);

    return () => {
      for (const track of videoTracks) {
        track.removeEventListener('mute', evaluateRemoteVideo);
        track.removeEventListener('unmute', evaluateRemoteVideo);
        track.removeEventListener('ended', evaluateRemoteVideo);
      }
      remoteStream.removeEventListener('addtrack', evaluateRemoteVideo);
      remoteStream.removeEventListener('removetrack', evaluateRemoteVideo);
    };
  }, [remoteStream]);

  // Gắn khung hình tự soi (local preview).
  React.useEffect(() => {
    const localEl = localVideoRef.current;
    if (!localEl) {
      return;
    }
    localEl.srcObject = isCameraEnabled ? localStream : null;
    if (isCameraEnabled && localStream) {
      void localEl.play().catch(() => undefined);
    }
    return () => {
      localEl.srcObject = null;
    };
  }, [isCameraEnabled, localStream]);

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  const statusText =
    phase === 'starting'
      ? 'Đang chuẩn bị cuộc gọi...'
      : phase === 'outgoing_ringing'
        ? 'Đang đổ chuông...'
        : phase === 'connecting'
          ? 'Đang kết nối...'
          : formatCallDurationClock(durationSeconds);

  const currentCorner = PIP_CORNER_ORDER[pipCornerIdx % PIP_CORNER_ORDER.length] ?? 'bottom-right';
  const showLocalSelfView =
    isCameraEnabled && Boolean(localStream && localStream.getVideoTracks().length > 0);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Cuộc gọi với ${activeCall.peer.fullName}`}
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950 text-white select-none"
    >
      {/* Phần tử âm thanh nền đảm bảo giọng nói luôn trong trẻo dù đang gọi thoại hay đối phương tắt cam */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Video đối phương toàn khung */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            'size-full object-cover transition-opacity duration-300',
            remoteVideoTrackLive ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />

        {/* Màn hình chờ / gọi thoại khi đối phương chưa bật camera */}
        {!remoteVideoTrackLive ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-zinc-900 via-zinc-950 to-black px-6 text-center">
            <div className="relative flex size-32 items-center justify-center">
              {phase === 'outgoing_ringing' || phase === 'connecting' || phase === 'starting' ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 animate-ping rounded-full bg-white/10"
                />
              ) : null}
              <UserAvatar
                fullName={activeCall.peer.fullName}
                avatarUrl={activeCall.peer.avatarUrl}
                size="xl"
                className="relative size-28 ring-4 ring-white/15"
              />
            </div>

            <h2 className="mt-5 text-xl font-bold tracking-tight text-white">
              {activeCall.peer.fullName}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">@{activeCall.peer.handle}</p>
            <p className="mt-3 rounded-full bg-white/10 px-4 py-1 text-sm font-medium tabular-nums text-zinc-100">
              {statusText}
            </p>
          </div>
        ) : null}

        {/* Thanh thông tin gọn gàng phía trên cùng khi đang hiển thị video */}
        <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 via-black/30 to-transparent px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {remoteVideoTrackLive ? (
              <>
                <UserAvatar
                  fullName={activeCall.peer.fullName}
                  avatarUrl={activeCall.peer.avatarUrl}
                  size="sm"
                  className="ring-2 ring-white/25"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {activeCall.peer.fullName}
                  </p>
                  <p className="text-xs font-medium tabular-nums text-zinc-200">{statusText}</p>
                </div>
              </>
            ) : (
              <span className="text-xs font-medium text-zinc-400">
                {activeCall.callType === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại'}
              </span>
            )}
          </div>
        </header>

        {/* Thông báo nhẹ trong cuộc gọi (thiếu camera / cảnh báo thiết bị) */}
        {noticeMessage ? (
          <div
            role="status"
            className="absolute top-16 left-1/2 z-10 max-w-sm -translate-x-1/2 rounded-full bg-zinc-900/90 px-4 py-2 text-center text-xs font-medium text-zinc-100 shadow-lg ring-1 ring-white/15"
          >
            {noticeMessage}
          </div>
        ) : null}

        {/* Khung hình tự soi (PiP) — bấm để chuyển đổi góc hiển thị */}
        {showLocalSelfView ? (
          <button
            type="button"
            onClick={() => setPipCornerIdx((prev) => (prev + 1) % PIP_CORNER_ORDER.length)}
            aria-label="Đổi vị trí khung hình tự soi"
            title="Chạm để đổi vị trí"
            className={cn(
              'absolute z-10 h-40 w-28 overflow-hidden rounded-2xl border border-white/25 bg-zinc-900 shadow-2xl transition-all hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:h-48 sm:w-36',
              PIP_CORNER_CLASS[currentCorner],
            )}
          >
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="size-full -scale-x-100 object-cover"
            />
          </button>
        ) : null}
      </div>

      {/* Thanh điều khiển tròn tối giản phía dưới */}
      <footer className="flex items-center justify-center gap-6 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-6 pt-4 pb-8">
        <button
          type="button"
          onClick={onToggleMicrophone}
          aria-label={isMicMuted ? 'Bật micro' : 'Tắt micro'}
          aria-pressed={isMicMuted}
          title={isMicMuted ? 'Bật micro' : 'Tắt micro'}
          className={cn(
            'flex size-14 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
            isMicMuted
              ? 'bg-white text-zinc-950 hover:bg-zinc-200'
              : 'bg-white/15 text-white hover:bg-white/25',
          )}
        >
          {isMicMuted ? (
            <MicOff className="size-6" aria-hidden="true" />
          ) : (
            <Mic className="size-6" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleCamera}
          aria-label={isCameraEnabled ? 'Tắt camera' : 'Bật camera'}
          aria-pressed={isCameraEnabled}
          title={isCameraEnabled ? 'Tắt camera' : 'Bật camera'}
          className={cn(
            'flex size-14 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white',
            !isCameraEnabled
              ? 'bg-white text-zinc-950 hover:bg-zinc-200'
              : 'bg-white/15 text-white hover:bg-white/25',
          )}
        >
          {isCameraEnabled ? (
            <Video className="size-6" aria-hidden="true" />
          ) : (
            <VideoOff className="size-6" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onEndCall}
          aria-label="Kết thúc cuộc gọi"
          title="Kết thúc cuộc gọi"
          className="flex size-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <PhoneOff className="size-6" aria-hidden="true" />
        </button>
      </footer>
    </div>,
    document.body,
  );
}
