/**
 * Helper chuẩn hóa lấy constructor `AudioContext` của trình duyệt (bao gồm tiền tố Safari cũ `webkitAudioContext`)
 * mà không cần ép kiểu `unknown` lặp lại ở nhiều nơi.
 */
interface WindowWithWebkitAudioContext extends Window {
  readonly webkitAudioContext?: typeof AudioContext;
}

export function getBrowserAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.AudioContext ?? (window as WindowWithWebkitAudioContext).webkitAudioContext ?? null;
}
