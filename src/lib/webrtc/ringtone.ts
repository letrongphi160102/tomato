import { getBrowserAudioContextConstructor } from '@/lib/audio-context';

/**
 * Bộ tạo âm báo nhẹ nhàng bằng Web Audio API cho cuộc gọi đến / chuông chờ.
 * Không phụ thuộc tệp âm thanh bên ngoài và tự tôn trọng chính sách autoplay của trình duyệt.
 */
export interface RingtoneController {
  start(mode: 'incoming' | 'outgoing'): void;
  stop(): void;
}

export function createCallRingtoneController(): RingtoneController {
  let audioCtx: AudioContext | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const playBurst = (mode: 'incoming' | 'outgoing') => {
    const AudioContextCtor = getBrowserAudioContextConstructor();
    if (!AudioContextCtor) {
      return;
    }

    try {
      if (!audioCtx) {
        audioCtx = new AudioContextCtor();
      }
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => undefined);
      }

      const now = audioCtx.currentTime;
      const gain = audioCtx.createGain();
      gain.connect(audioCtx.destination);

      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.connect(gain);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // Bỏ qua nếu AudioContext đã đóng.
        }
      };

      if (mode === 'incoming') {
        // 2 nốt chuông êm dịu cách nhau ngắn
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.16); // E5
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.045, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.48);
      } else {
        // Nhịp chuông chờ nhẹ cho người gọi
        osc.frequency.setValueAtTime(440, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.025, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.38);
      }
    } catch {
      // Bỏ qua nếu trình duyệt chặn phát âm thanh trước khi có tương tác người dùng.
    }
  };

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (audioCtx) {
      try {
        void audioCtx.close().catch(() => undefined);
      } catch {
        // Bỏ qua lỗi khi đóng AudioContext.
      }
      audioCtx = null;
    }
  };

  const start = (mode: 'incoming' | 'outgoing') => {
    stop();
    playBurst(mode);
    intervalId = setInterval(() => playBurst(mode), mode === 'incoming' ? 2_200 : 2_800);
  };

  return { start, stop };
}
