const STORAGE_KEY = 'tomato:pending-email-verification';
const PENDING_HINT_TTL_MS = 30 * 60 * 1000; // 30 phút

export interface PendingVerificationHint {
  readonly email: string;
  readonly sentAt: number;
  readonly notice?: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined = undefined;
let cachedHint: PendingVerificationHint | null = null;

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Lưu tạm email và mốc gửi OTP vào `sessionStorage` phía client để tránh lộ email trên URL/Referer
 * khi điều hướng `/register` -> `/verify-email`. Tuyệt đối không lưu mật khẩu, OTP hay token.
 */
export function savePendingVerificationHint(hint: PendingVerificationHint): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const serialized = JSON.stringify(hint);
    window.sessionStorage.setItem(STORAGE_KEY, serialized);
    cachedRaw = serialized;
    cachedHint = hint;
    notifyListeners();
  } catch {
    // Bỏ qua nếu trình duyệt chặn storage trong chế độ riêng tư nghiêm ngặt.
  }
}

export function loadPendingVerificationHint(): PendingVerificationHint | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) {
      return cachedHint;
    }
    if (!raw) {
      cachedRaw = null;
      cachedHint = null;
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PendingVerificationHint>;
    if (
      typeof parsed.email !== 'string' ||
      typeof parsed.sentAt !== 'number' ||
      Date.now() - parsed.sentAt > PENDING_HINT_TTL_MS
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      cachedRaw = null;
      cachedHint = null;
      return null;
    }
    cachedRaw = raw;
    cachedHint = {
      email: parsed.email,
      sentAt: parsed.sentAt,
      notice: typeof parsed.notice === 'string' ? parsed.notice : undefined,
    };
    return cachedHint;
  } catch {
    return null;
  }
}

export function subscribePendingVerificationHint(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearPendingVerificationHint(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    cachedRaw = null;
    cachedHint = null;
    notifyListeners();
  } catch {
    // Bỏ qua lỗi storage.
  }
}
