'use client';

import * as React from 'react';
import { Check, Image as ImageIcon, Loader2, Mic, Send, Trash2, X } from 'lucide-react';

import { EmojiPickerPopover } from '@/components/messages/emoji-picker-popover';
import { MessageEditBanner } from '@/components/messages/message-edit-banner';
import { Button } from '@/components/ui/button';
import {
  MAX_CHAT_IMAGE_INPUT_BYTES,
  MAX_CHAT_IMAGES_PER_BATCH,
  MAX_CHAT_VOICE_DURATION_MS,
  MAX_CHAT_VOICE_INPUT_BYTES,
  MIN_CHAT_VOICE_DURATION_MS,
  VOICE_WAVEFORM_BAR_COUNT,
  normalizeWaveformBars,
  pickSupportedVoiceRecorderMimeType,
} from '@/lib/e2ee/media-cipher';
import { cn } from '@/lib/utils';

export interface StagedChatImage {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string;
}

export interface RecordedChatVoice {
  readonly audioBlob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly waveform: readonly number[];
}

function formatTimerMmSs(ms: number): string {
  const totalSecs = Math.min(120, Math.max(0, Math.floor(ms / 1000)));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function validateCandidateImages(
  incoming: readonly File[],
  existingCount: number,
): {
  readonly accepted: File[];
  readonly notice: string | null;
} {
  const accepted: File[] = [];
  let rejectedType = false;
  let rejectedSize = false;
  let truncatedCount = false;

  const remainingSlots = Math.max(0, MAX_CHAT_IMAGES_PER_BATCH - existingCount);

  for (const file of incoming) {
    const mime = (file.type || '').trim().toLowerCase();
    const isAllowedMime =
      mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === '';
    if (!isAllowedMime || mime.includes('svg') || file.name.toLowerCase().endsWith('.svg')) {
      rejectedType = true;
      continue;
    }
    if (file.size <= 0 || file.size > MAX_CHAT_IMAGE_INPUT_BYTES) {
      rejectedSize = true;
      continue;
    }
    if (accepted.length >= remainingSlots) {
      truncatedCount = true;
      continue;
    }
    accepted.push(file);
  }

  let notice: string | null = null;
  if (rejectedType) {
    notice = 'Chỉ hỗ trợ ảnh PNG, JPG hoặc WebP.';
  } else if (rejectedSize) {
    notice = 'Mỗi ảnh có dung lượng tối đa 10 MB.';
  } else if (truncatedCount) {
    notice = `Bạn có thể gửi tối đa ${MAX_CHAT_IMAGES_PER_BATCH} ảnh mỗi lần.`;
  }

  return { accepted, notice };
}

interface ChatVoiceRecorderBarProps {
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly onSendVoice: (recorded: RecordedChatVoice) => Promise<void>;
  readonly onCancel: () => void;
  readonly onError: (message: string) => void;
}

/**
 * Thanh ghi âm tin nhắn thoại an toàn tài nguyên trình duyệt:
 * luôn giải phóng toàn bộ micro track (`stream.getTracks().forEach(t => t.stop())`)
 * ở mọi nhánh thoát: Hủy, Gửi, chạm mốc 2:00, đổi cuộc trò chuyện hoặc unmount.
 */
function ChatVoiceRecorderBar({
  compact,
  disabled,
  onSendVoice,
  onCancel,
  onError,
}: ChatVoiceRecorderBarProps) {
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [liveLevels, setLiveLevels] = React.useState<readonly number[]>(() =>
    Array.from({ length: 16 }, () => 18),
  );
  const [finalizing, setFinalizing] = React.useState(false);

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const samplesRef = React.useRef<number[]>([]);
  const startedAtRef = React.useRef<number>(0);
  const timerIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const levelIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const actionOnStopRef = React.useRef<'send' | 'cancel'>('cancel');
  const disposedRef = React.useRef(false);
  const onSendVoiceRef = React.useRef(onSendVoice);
  const onCancelRef = React.useRef(onCancel);
  const onErrorRef = React.useRef(onError);

  React.useEffect(() => {
    onSendVoiceRef.current = onSendVoice;
    onCancelRef.current = onCancel;
    onErrorRef.current = onError;
  }, [onCancel, onError, onSendVoice]);

  const releaseMicrophoneResources = React.useCallback(() => {
    if (timerIntervalRef.current !== null) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (levelIntervalRef.current !== null) {
      clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Bỏ qua nếu track đã dừng.
        }
      });
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    disposedRef.current = false;
    actionOnStopRef.current = 'cancel';
    chunksRef.current = [];
    samplesRef.current = [];

    async function startRecording() {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function' ||
        typeof MediaRecorder === 'undefined'
      ) {
        onErrorRef.current('Trình duyệt hiện tại không hỗ trợ ghi âm tin nhắn thoại.');
        onCancelRef.current();
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (disposedRef.current) {
          return;
        }
        const errName = err instanceof Error ? err.name : '';
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          onErrorRef.current('Vui lòng cấp quyền micro trong trình duyệt để gửi tin nhắn thoại.');
        } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
          onErrorRef.current('Không tìm thấy micro trên thiết bị này.');
        } else {
          onErrorRef.current('Không thể bật micro lúc này. Vui lòng thử lại.');
        }
        onCancelRef.current();
        return;
      }

      if (disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      try {
        const AudioCtxCtor =
          window.AudioContext ||
          (window as unknown as { readonly webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtxCtor) {
          const ctx = new AudioCtxCtor();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          levelIntervalRef.current = setInterval(() => {
            analyser.getByteTimeDomainData(dataArray);
            let sumSquares = 0;
            for (let i = 0; i < dataArray.length; i += 1) {
              const centered = (dataArray[i]! - 128) / 128;
              sumSquares += centered * centered;
            }
            const rms = Math.sqrt(sumSquares / dataArray.length);
            const scaled = Math.max(12, Math.min(100, Math.round(rms * 380)));
            samplesRef.current.push(scaled);
            setLiveLevels((prev) => [...prev.slice(1), scaled]);
          }, 120);
        }
      } catch {
        // Fallback giữ thanh sóng âm mặc định nếu AudioContext không khởi tạo được.
      }

      const preferredMime = pickSupportedVoiceRecorderMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = preferredMime
          ? new MediaRecorder(stream, {
              mimeType: preferredMime,
              audioBitsPerSecond: 32_000,
            })
          : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }

      recorderRef.current = recorder;
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const elapsed = Math.min(
          MAX_CHAT_VOICE_DURATION_MS,
          Math.max(0, Date.now() - startedAtRef.current),
        );
        const intent = actionOnStopRef.current;
        const mime = recorder.mimeType || preferredMime || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        const waveform = normalizeWaveformBars(samplesRef.current, VOICE_WAVEFORM_BAR_COUNT);

        releaseMicrophoneResources();
        recorderRef.current = null;
        chunksRef.current = [];
        samplesRef.current = [];

        if (disposedRef.current || intent !== 'send') {
          return;
        }

        if (elapsed < MIN_CHAT_VOICE_DURATION_MS || blob.size === 0) {
          onErrorRef.current('Tin nhắn thoại quá ngắn. Vui lòng giữ lâu hơn một chút.');
          onCancelRef.current();
          return;
        }

        if (blob.size > MAX_CHAT_VOICE_INPUT_BYTES) {
          onErrorRef.current('Tin nhắn thoại vượt quá giới hạn tối đa 5 MB.');
          onCancelRef.current();
          return;
        }

        void onSendVoiceRef
          .current({
            audioBlob: blob,
            mimeType: mime,
            durationMs: elapsed,
            waveform,
          })
          .finally(() => {
            if (!disposedRef.current) {
              onCancelRef.current();
            }
          });
      };

      recorder.start(250);

      timerIntervalRef.current = setInterval(() => {
        const nowElapsed = Date.now() - startedAtRef.current;
        setElapsedMs(Math.min(MAX_CHAT_VOICE_DURATION_MS, nowElapsed));
        if (nowElapsed >= MAX_CHAT_VOICE_DURATION_MS) {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            actionOnStopRef.current = 'send';
            setFinalizing(true);
            recorderRef.current.stop();
          } else {
            releaseMicrophoneResources();
          }
        }
      }, 200);
    }

    void startRecording();

    return () => {
      disposedRef.current = true;
      actionOnStopRef.current = 'cancel';
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try {
          recorderRef.current.stop();
        } catch {
          // Bỏ qua nếu đã dừng.
        }
      }
      recorderRef.current = null;
      releaseMicrophoneResources();
    };
  }, [releaseMicrophoneResources]);

  function handleCancelClick() {
    actionOnStopRef.current = 'cancel';
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      releaseMicrophoneResources();
    }
    onCancel();
  }

  function handleSendClick() {
    if (finalizing || disabled) {
      return;
    }
    actionOnStopRef.current = 'send';
    setFinalizing(true);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else {
      releaseMicrophoneResources();
      onCancel();
    }
  }

  return (
    <div
      role="region"
      aria-label="Đang ghi âm tin nhắn thoại"
      className={cn(
        'flex items-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/5',
        compact ? 'px-1.5 py-1.5' : 'px-2 py-1.5',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={finalizing}
        aria-label="Hủy ghi âm"
        title="Hủy"
        onClick={handleCancelClick}
        className={cn(
          'shrink-0 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
          compact ? 'size-8' : 'size-9',
        )}
      >
        <Trash2 className={cn(compact ? 'size-[18px]' : 'size-5')} aria-hidden="true" />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive"
        />
        <span
          className={cn(
            'shrink-0 font-mono font-semibold tabular-nums text-foreground',
            compact ? 'text-[11px]' : 'text-xs',
          )}
        >
          {formatTimerMmSs(elapsedMs)} / 2:00
        </span>

        <div aria-hidden="true" className="flex h-5 min-w-0 flex-1 items-center gap-[2px] px-1">
          {liveLevels.map((lvl, idx) => (
            <span
              key={idx}
              style={{ height: `${Math.max(18, Math.min(100, lvl))}%` }}
              className="flex-1 rounded-full bg-destructive/65 transition-all duration-100"
            />
          ))}
        </div>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={finalizing || disabled}
        onClick={handleSendClick}
        className={cn('shrink-0 rounded-full text-xs', compact ? 'h-8 px-3' : 'h-9 px-3.5')}
      >
        {finalizing ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Send className="size-4" aria-hidden="true" />
        )}
        <span>Gửi</span>
      </Button>
    </div>
  );
}

export interface ChatComposerWithMediaProps {
  readonly compact?: boolean;
  readonly canSendMedia: boolean;
  readonly canSendMoreMessages: boolean;
  readonly draftText: string;
  readonly editDraftText: string;
  readonly editingOriginalText: string | null;
  readonly editSaving: boolean;
  readonly composerInputRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onChangeDraftText: (next: string) => void;
  readonly onChangeEditDraftText: (next: string) => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitTextOrEdit: (event?: React.FormEvent) => Promise<void>;
  readonly onSendImageFile: (file: File) => Promise<void>;
  readonly onSendVoice: (recorded: RecordedChatVoice) => Promise<void>;
  readonly onError: (message: string | null) => void;
}

/**
 * Thanh soạn tin nhắn dùng chung cho cả `/messages` và `FloatingMessagesWidget`.
 * Bắt buộc truyền `key={conversation.public_id}` khi render để mọi thao tác chuyển cuộc trò chuyện
 * tự động hủy khay ảnh nháp (kèm `URL.revokeObjectURL`) và tắt sạch micro đang ghi âm.
 */
export function ChatComposerWithMedia({
  compact = false,
  canSendMedia,
  canSendMoreMessages,
  draftText,
  editDraftText,
  editingOriginalText,
  editSaving,
  composerInputRef,
  onChangeDraftText,
  onChangeEditDraftText,
  onCancelEdit,
  onSubmitTextOrEdit,
  onSendImageFile,
  onSendVoice,
  onError,
}: ChatComposerWithMediaProps) {
  const isEditing = editingOriginalText !== null;
  const fileInputId = React.useId();
  const messageInputId = React.useId();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [stagedImages, setStagedImages] = React.useState<readonly StagedChatImage[]>([]);
  const [isRecordingVoice, setIsRecordingVoice] = React.useState(false);
  const [sendingMedia, setSendingMedia] = React.useState(false);
  const stagedImagesRef = React.useRef<readonly StagedChatImage[]>([]);

  React.useEffect(() => {
    stagedImagesRef.current = stagedImages;
  }, [stagedImages]);

  // Dọn toàn bộ ObjectURL xem trước khi đổi hội thoại hoặc unmount.
  React.useEffect(() => {
    return () => {
      for (const img of stagedImagesRef.current) {
        URL.revokeObjectURL(img.previewUrl);
      }
      stagedImagesRef.current = [];
    };
  }, []);

  function addCandidateFiles(files: readonly File[]) {
    if (!canSendMedia || isEditing || sendingMedia) {
      return;
    }
    const { accepted, notice } = validateCandidateImages(files, stagedImagesRef.current.length);
    onError(notice);
    if (accepted.length > 0) {
      const created: StagedChatImage[] = accepted.map((file) => ({
        id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      setStagedImages((prev) => [...prev, ...created]);
    }
  }

  function removeStagedImage(id: string) {
    setStagedImages((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }

  async function sendAllStagedImagesSequentially() {
    if (sendingMedia || stagedImagesRef.current.length === 0) {
      return;
    }
    const queue = [...stagedImagesRef.current];
    setSendingMedia(true);
    onError(null);
    let lastError: string | null = null;

    try {
      for (const item of queue) {
        try {
          await onSendImageFile(item.file);
          removeStagedImage(item.id);
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Không thể gửi ảnh lúc này.';
        }
      }
      if (lastError) {
        onError(lastError);
      }
    } finally {
      setSendingMedia(false);
    }
  }

  async function handleFormSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (isEditing) {
      await onSubmitTextOrEdit(event);
      return;
    }

    const hasText = draftText.trim().length > 0;
    const hasImages = stagedImagesRef.current.length > 0;

    if (hasImages) {
      await sendAllStagedImagesSequentially();
    }
    if (hasText) {
      await onSubmitTextOrEdit();
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (isEditing || !canSendMedia || sendingMedia) {
      return;
    }
    const clipboardItems = Array.from(event.clipboardData?.items ?? []);
    const pastedImageFiles: File[] = [];
    for (const item of clipboardItems) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pastedImageFiles.push(file);
        }
      }
    }
    if (pastedImageFiles.length > 0) {
      event.preventDefault();
      addCandidateFiles(pastedImageFiles);
    }
  }

  const pendingHint = 'Chỉ hỗ trợ tin nhắn chữ cho đến khi được chấp nhận';
  const activeText = isEditing ? editDraftText : draftText;
  const canSubmit = isEditing
    ? !editSaving && activeText.trim().length > 0
    : !sendingMedia &&
      canSendMoreMessages &&
      (activeText.trim().length > 0 || stagedImages.length > 0);

  if (isRecordingVoice && !isEditing && canSendMedia) {
    return (
      <ChatVoiceRecorderBar
        compact={compact}
        disabled={sendingMedia}
        onSendVoice={async (recorded) => {
          setSendingMedia(true);
          onError(null);
          try {
            await onSendVoice(recorded);
          } catch (err) {
            onError(err instanceof Error ? err.message : 'Không thể gửi tin nhắn thoại lúc này.');
          } finally {
            setSendingMedia(false);
          }
        }}
        onCancel={() => setIsRecordingVoice(false)}
        onError={(msg) => onError(msg)}
      />
    );
  }

  return (
    <div>
      {isEditing ? (
        <MessageEditBanner
          originalText={editingOriginalText}
          compact={compact}
          saving={editSaving}
          onCancel={onCancelEdit}
        />
      ) : null}

      {!isEditing && stagedImages.length > 0 ? (
        <div
          className={cn(
            'mb-2 flex items-center gap-2 rounded-xl border bg-muted/35',
            compact ? 'p-1.5' : 'p-2',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5">
            {stagedImages.map((img) => (
              <div
                key={img.id}
                className={cn(
                  'relative shrink-0 overflow-hidden rounded-lg border bg-background',
                  compact ? 'size-12' : 'size-14',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.previewUrl} alt="Ảnh đã chọn" className="size-full object-cover" />
                {!sendingMedia ? (
                  <button
                    type="button"
                    aria-label="Gỡ ảnh này"
                    onClick={() => removeStagedImage(img.id)}
                    className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black"
                  >
                    <X className="size-2.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
            {stagedImages.length}/{MAX_CHAT_IMAGES_PER_BATCH}
          </span>
        </div>
      ) : null}

      <form
        onSubmit={(e) => void handleFormSubmit(e)}
        className={cn(
          'flex items-end rounded-2xl border bg-muted/30 focus-within:border-primary/60 focus-within:bg-background',
          compact ? 'gap-1 px-1.5 py-1.5' : 'gap-1.5 px-2 py-1.5',
        )}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <EmojiPickerPopover
            compact={compact}
            disabled={(!isEditing && !canSendMoreMessages) || sendingMedia}
            onSelectEmoji={(emoji) =>
              isEditing
                ? onChangeEditDraftText(`${editDraftText}${emoji}`)
                : onChangeDraftText(`${draftText}${emoji}`)
            }
          />

          {!isEditing ? (
            <>
              <input
                ref={fileInputRef}
                id={fileInputId}
                name="chatMediaFiles"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  if (picked.length > 0) {
                    addCandidateFiles(picked);
                  }
                }}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={
                  !canSendMedia || sendingMedia || stagedImages.length >= MAX_CHAT_IMAGES_PER_BATCH
                }
                title={canSendMedia ? 'Gửi ảnh' : pendingHint}
                aria-label={canSendMedia ? 'Gửi ảnh' : 'Gửi ảnh (đang khóa trong tin nhắn chờ)'}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'shrink-0 rounded-full text-muted-foreground hover:text-foreground',
                  compact ? 'size-8' : 'size-9',
                  !canSendMedia ? 'opacity-40' : null,
                )}
              >
                <ImageIcon className={cn(compact ? 'size-[18px]' : 'size-5')} aria-hidden="true" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={!canSendMedia || sendingMedia}
                title={canSendMedia ? 'Ghi âm tin nhắn thoại' : pendingHint}
                aria-label={
                  canSendMedia
                    ? 'Ghi âm tin nhắn thoại'
                    : 'Ghi âm tin nhắn thoại (đang khóa trong tin nhắn chờ)'
                }
                onClick={() => {
                  onError(null);
                  setIsRecordingVoice(true);
                }}
                className={cn(
                  'shrink-0 rounded-full text-muted-foreground hover:text-foreground',
                  compact ? 'size-8' : 'size-9',
                  !canSendMedia ? 'opacity-40' : null,
                )}
              >
                <Mic className={cn(compact ? 'size-[18px]' : 'size-5')} aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>

        <textarea
          ref={composerInputRef}
          id={messageInputId}
          name="chatMessage"
          rows={1}
          value={activeText}
          aria-label={isEditing ? 'Chỉnh sửa nội dung tin nhắn' : 'Nhập tin nhắn'}
          disabled={editSaving || sendingMedia || (!isEditing && !canSendMoreMessages)}
          placeholder={
            isEditing
              ? 'Nhập nội dung mới...'
              : canSendMoreMessages
                ? stagedImages.length > 0
                  ? 'Nhấn Gửi để gửi ảnh...'
                  : 'Nhắn tin...'
                : compact
                  ? 'Đã gửi tối đa 3 tin chờ'
                  : 'Đã gửi tối đa 3 tin nhắn đang chờ chấp nhận'
          }
          onChange={(e) =>
            isEditing ? onChangeEditDraftText(e.target.value) : onChangeDraftText(e.target.value)
          }
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && isEditing && !editSaving) {
              e.preventDefault();
              onCancelEdit();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleFormSubmit();
            }
          }}
          className={cn(
            'min-w-0 flex-1 resize-none bg-transparent px-1 leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'max-h-24 min-h-8 py-1.5 text-xs' : 'max-h-28 min-h-9 py-2 text-sm',
          )}
        />

        <Button
          type="submit"
          size={compact ? 'icon' : 'sm'}
          disabled={!canSubmit}
          aria-label={isEditing ? 'Lưu chỉnh sửa' : 'Gửi tin nhắn'}
          className={cn('shrink-0 rounded-full', compact ? 'size-8 p-0' : 'h-9 px-3.5 text-xs')}
        >
          {editSaving || sendingMedia ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : isEditing ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
          {!compact ? <span>{isEditing ? 'Lưu' : 'Gửi'}</span> : null}
        </Button>
      </form>
    </div>
  );
}
