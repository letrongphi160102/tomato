'use client';

import * as React from 'react';
import { ImageOff, Loader2, Pause, Play, RotateCcw } from 'lucide-react';

import {
  useChatStore,
  type DecryptedMessageViewItem,
} from '@/components/messages/chat-store-context';
import type { ImageLightboxTarget } from '@/components/messages/image-lightbox-modal';
import { cn } from '@/lib/utils';

// Bộ điều phối phát âm thanh đơn kênh toàn cục: bấm phát tin nhắn thoại mới tự tạm dừng tin đang phát.
let activeVoicePlayerId: string | null = null;
const voiceStopListeners = new Map<string, () => void>();

function claimActiveVoicePlayback(playerId: string): void {
  if (activeVoicePlayerId && activeVoicePlayerId !== playerId) {
    const prevStop = voiceStopListeners.get(activeVoicePlayerId);
    prevStop?.();
  }
  activeVoicePlayerId = playerId;
}

function releaseActiveVoicePlayback(playerId: string): void {
  if (activeVoicePlayerId === playerId) {
    activeVoicePlayerId = null;
  }
}

const DEFAULT_WAVEFORM_BARS: readonly number[] = [
  24, 42, 65, 38, 82, 54, 72, 30, 48, 90, 62, 44, 76, 35, 58, 84, 46, 68, 32, 74, 52, 64, 40, 28,
];

const PLAYBACK_RATES = [1, 1.5, 2] as const;

function formatAudioSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface MessageMediaContentProps {
  readonly item: DecryptedMessageViewItem;
  readonly isMine: boolean;
  readonly isCompact: boolean;
  readonly onOpenLightbox?: (target: ImageLightboxTarget) => void;
}

export function MessageMediaContent({
  item,
  isMine,
  isCompact,
  onOpenLightbox,
}: MessageMediaContentProps) {
  const chatStore = useChatStore();
  const media = item.media;
  const msgPublicId = item.dto.public_id;
  const cachedUrl = chatStore?.getCachedMediaObjectUrl(msgPublicId) ?? null;

  const [resolvedUrl, setResolvedUrl] = React.useState<string | null>(
    () => item.localPreviewUrl ?? cachedUrl,
  );
  const [mediaError, setMediaError] = React.useState(false);
  const [retryToken, setRetryToken] = React.useState(0);

  const effectiveUrl = item.localPreviewUrl ?? resolvedUrl ?? cachedUrl;

  // Ảnh HD: tự động tải & giải mã ngay khi tin nhắn hiển thị (chỉ khi đã giải mã phong bì thành công và không ở trạng thái đang gửi).
  const isImage = item.dto.messageType === 'image';
  const isVoice = item.dto.messageType === 'voice';
  const loadingMedia =
    isImage &&
    Boolean(media) &&
    !item.sending &&
    !item.decryptionFailed &&
    item.dto.recalledAt === null &&
    !effectiveUrl &&
    !mediaError;

  React.useEffect(() => {
    if (
      !isImage ||
      !media ||
      !chatStore ||
      item.sending ||
      item.decryptionFailed ||
      item.dto.recalledAt !== null ||
      effectiveUrl ||
      mediaError
    ) {
      return;
    }

    let cancelled = false;

    void chatStore
      .resolveMessageMediaObjectUrl(item)
      .then((url) => {
        if (cancelled) {
          return;
        }
        if (url) {
          setResolvedUrl(url);
        } else {
          setMediaError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMediaError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chatStore, effectiveUrl, isImage, item, media, mediaError, retryToken]);

  if (isImage) {
    const width = media?.width ?? 4;
    const height = media?.height ?? 3;
    const safeRatio = Math.max(0.55, Math.min(2.1, width / Math.max(1, height)));
    const maxWidthPx = isCompact ? 220 : 290;
    const computedHeightPx = Math.min(isCompact ? 260 : 340, Math.round(maxWidthPx / safeRatio));
    const displayWidthPx = Math.min(maxWidthPx, Math.round(computedHeightPx * safeRatio));

    return (
      <div
        style={{ width: `${displayWidthPx}px`, height: `${computedHeightPx}px` }}
        className="relative overflow-hidden bg-muted/50"
      >
        {media?.thumbnailDataUrl && !effectiveUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.thumbnailDataUrl}
            alt=""
            aria-hidden="true"
            className="size-full scale-105 object-cover blur-md"
          />
        ) : null}

        {effectiveUrl ? (
          <button
            type="button"
            disabled={Boolean(item.sending)}
            onClick={(event) => {
              event.stopPropagation();
              onOpenLightbox?.({
                src: effectiveUrl,
                mimeType: media?.mimeType,
                alt: 'Ảnh trong cuộc trò chuyện',
              });
            }}
            aria-label="Mở ảnh kích thước đầy đủ"
            className="block size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={effectiveUrl}
              alt="Ảnh trong cuộc trò chuyện"
              className="size-full object-cover transition-opacity duration-200"
            />
          </button>
        ) : mediaError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted/75 px-3 text-center text-muted-foreground">
            <ImageOff className="size-5" aria-hidden="true" />
            <span className="text-[11px]">Không tải được ảnh</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMediaError(false);
                setRetryToken((prev) => prev + 1);
              }}
              className="inline-flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-0.5 text-[11px] font-medium text-foreground shadow-xs hover:bg-background"
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              <span>Thử lại</span>
            </button>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-black/15">
            <Loader2
              aria-label="Đang tải ảnh"
              className="size-5 animate-spin text-white drop-shadow-xs"
            />
          </div>
        )}

        {item.sending || loadingMedia ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
            <Loader2 className="size-5 animate-spin text-white drop-shadow-xs" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    );
  }

  if (isVoice) {
    return (
      <VoiceMessagePlayer
        item={item}
        isMine={isMine}
        isCompact={isCompact}
        initialAudioUrl={effectiveUrl}
        onResolvedAudioUrl={setResolvedUrl}
      />
    );
  }

  return null;
}

interface VoiceMessagePlayerProps {
  readonly item: DecryptedMessageViewItem;
  readonly isMine: boolean;
  readonly isCompact: boolean;
  readonly initialAudioUrl: string | null;
  readonly onResolvedAudioUrl: (url: string) => void;
}

function VoiceMessagePlayer({
  item,
  isMine,
  isCompact,
  initialAudioUrl,
  onResolvedAudioUrl,
}: VoiceMessagePlayerProps) {
  const chatStore = useChatStore();
  const playerId = React.useId();
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const playbackRateRef = React.useRef<(typeof PLAYBACK_RATES)[number]>(1);

  const [audioUrl, setAudioUrl] = React.useState<string | null>(initialAudioUrl);
  const [loadingAudio, setLoadingAudio] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTimeSec, setCurrentTimeSec] = React.useState(0);
  const [durationSec, setDurationSec] = React.useState<number>(() =>
    item.media?.durationMs ? item.media.durationMs / 1000 : 0,
  );
  const [rateIndex, setRateIndex] = React.useState(0);

  const effectiveAudioUrl = initialAudioUrl ?? audioUrl;
  const waveform =
    item.media?.waveform && item.media.waveform.length > 0
      ? item.media.waveform
      : DEFAULT_WAVEFORM_BARS;

  React.useEffect(() => {
    const stopPlayback = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        audio.pause();
      }
      setIsPlaying(false);
    };
    voiceStopListeners.set(playerId, stopPlayback);
    return () => {
      stopPlayback();
      voiceStopListeners.delete(playerId);
      releaseActiveVoicePlayback(playerId);
    };
  }, [playerId]);

  async function ensureAudioAndPlay() {
    if (item.sending) {
      return;
    }

    let urlToPlay = effectiveAudioUrl;
    if (!urlToPlay && chatStore) {
      setLoadingAudio(true);
      setLoadFailed(false);
      try {
        urlToPlay = await chatStore.resolveMessageMediaObjectUrl(item);
        if (!urlToPlay) {
          setLoadFailed(true);
          return;
        }
        setAudioUrl(urlToPlay);
        onResolvedAudioUrl(urlToPlay);
      } catch {
        setLoadFailed(true);
        return;
      } finally {
        setLoadingAudio(false);
      }
    }

    if (!urlToPlay) {
      return;
    }

    claimActiveVoicePlayback(playerId);

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.src !== urlToPlay) {
      audio.src = urlToPlay;
    }
    audio.playbackRate = playbackRateRef.current;

    try {
      await audio.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
      releaseActiveVoicePlayback(playerId);
    }
  }

  function handleTogglePlay(event: React.MouseEvent) {
    event.stopPropagation();
    const audio = audioRef.current;
    if (isPlaying && audio) {
      audio.pause();
      setIsPlaying(false);
      releaseActiveVoicePlayback(playerId);
      return;
    }
    void ensureAudioAndPlay();
  }

  function handleSeekByBarIndex(event: React.MouseEvent, barIndex: number) {
    event.stopPropagation();
    const audio = audioRef.current;
    const total =
      audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationSec;
    if (!audio || !effectiveAudioUrl || total <= 0) {
      return;
    }
    const targetSec = ((barIndex + 0.5) / waveform.length) * total;
    audio.currentTime = Math.max(0, Math.min(total, targetSec));
    setCurrentTimeSec(audio.currentTime);
  }

  function handleCycleRate(event: React.MouseEvent) {
    event.stopPropagation();
    const nextIdx = (rateIndex + 1) % PLAYBACK_RATES.length;
    const nextRate = PLAYBACK_RATES[nextIdx] ?? 1;
    setRateIndex(nextIdx);
    playbackRateRef.current = nextRate;
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  }

  const progressRatio =
    durationSec > 0 ? Math.min(1, Math.max(0, currentTimeSec / durationSec)) : 0;
  const activeBars = Math.round(progressRatio * waveform.length);
  const currentRate = PLAYBACK_RATES[rateIndex] ?? 1;

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'flex items-center gap-2',
        isCompact ? 'min-w-[196px] max-w-[235px]' : 'min-w-[232px] max-w-[290px]',
      )}
    >
      <audio
        ref={audioRef}
        src={effectiveAudioUrl ?? undefined}
        preload="none"
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setDurationSec(d);
          }
        }}
        onTimeUpdate={(event) => {
          setCurrentTimeSec(event.currentTarget.currentTime);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTimeSec(0);
          releaseActiveVoicePlayback(playerId);
        }}
        onPause={() => {
          setIsPlaying(false);
        }}
        className="hidden"
      />

      <button
        type="button"
        disabled={Boolean(item.sending) || loadingAudio}
        onClick={handleTogglePlay}
        aria-label={isPlaying ? 'Tạm dừng tin nhắn thoại' : 'Phát tin nhắn thoại'}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
          isCompact ? 'size-7' : 'size-8',
          isMine
            ? 'bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
        )}
      >
        {loadingAudio || item.sending ? (
          <Loader2
            className={cn(isCompact ? 'size-3.5' : 'size-4', 'animate-spin')}
            aria-hidden="true"
          />
        ) : isPlaying ? (
          <Pause
            className={cn(isCompact ? 'size-3.5' : 'size-4', 'fill-current')}
            aria-hidden="true"
          />
        ) : (
          <Play
            className={cn(isCompact ? 'size-3.5' : 'size-4', 'translate-x-[0.5px] fill-current')}
            aria-hidden="true"
          />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {loadFailed ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void ensureAudioAndPlay();
            }}
            className="inline-flex items-center gap-1 text-[11px] font-medium underline opacity-90"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            <span>Không tải được, nhấn thử lại</span>
          </button>
        ) : (
          <div
            role="group"
            aria-label="Sóng âm tin nhắn thoại"
            className={cn('flex w-full items-center gap-[2px]', isCompact ? 'h-5' : 'h-6')}
          >
            {waveform.map((barValue, idx) => {
              const barHeightPercent = Math.max(18, Math.min(100, barValue));
              const isPlayed = idx < activeBars;
              return (
                <button
                  key={idx}
                  type="button"
                  tabIndex={-1}
                  aria-label={`Tua tới vị trí ${Math.round(((idx + 1) / waveform.length) * 100)}%`}
                  onClick={(event) => handleSeekByBarIndex(event, idx)}
                  style={{ height: `${barHeightPercent}%` }}
                  className={cn(
                    'flex-1 rounded-full transition-colors',
                    isMine
                      ? isPlayed
                        ? 'bg-primary-foreground'
                        : 'bg-primary-foreground/40 hover:bg-primary-foreground/65'
                      : isPlayed
                        ? 'bg-primary'
                        : 'bg-foreground/25 hover:bg-foreground/45',
                  )}
                />
              );
            })}
          </div>
        )}

        <div
          className={cn(
            'flex items-center justify-between text-[10px] tabular-nums',
            isMine ? 'text-primary-foreground/80' : 'text-muted-foreground',
          )}
        >
          <span>
            {formatAudioSeconds(isPlaying || currentTimeSec > 0 ? currentTimeSec : durationSec)}
          </span>

          <button
            type="button"
            onClick={handleCycleRate}
            aria-label={`Đổi tốc độ phát (hiện tại ${currentRate}x)`}
            className={cn(
              'rounded-full px-1.5 py-0.25 text-[10px] font-semibold transition-colors',
              isMine
                ? 'bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25'
                : 'bg-muted text-foreground hover:bg-muted/80',
            )}
          >
            {currentRate}x
          </button>
        </div>
      </div>
    </div>
  );
}
