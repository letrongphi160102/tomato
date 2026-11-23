const CSRF_COOKIE_NAMES = ['__Host-tomato_csrf', 'tomato_csrf'] as const;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;

/** Thời hạn Access Token JWT phía máy chủ (15 phút). */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Chủ động làm mới Access Token trước khi hết hạn 90 giây (mốc 13p30s) để tránh nhịp 401 trên Console. */
export const PROACTIVE_REFRESH_LEAD_MS = 90 * 1000;

const AUTH_FRESHNESS_STORAGE_KEY = 'tomato_auth_at_freshness_v1';
const AUTH_REFRESH_LOCK_NAME = 'tomato:auth:refresh';
const RECENT_CROSS_TAB_REFRESH_WINDOW_MS = 10_000;

interface StoredFreshnessState {
  readonly freshUntilMs: number;
  readonly refreshedAtMs: number;
}

let refreshInFlight: Promise<boolean> | null = null;
let memoryFreshness: StoredFreshnessState | null = null;

function readFreshnessState(): StoredFreshnessState | null {
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(AUTH_FRESHNESS_STORAGE_KEY);
      if (!raw) {
        memoryFreshness = null;
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Partial<StoredFreshnessState>).freshUntilMs === 'number' &&
        Number.isFinite((parsed as Partial<StoredFreshnessState>).freshUntilMs) &&
        typeof (parsed as Partial<StoredFreshnessState>).refreshedAtMs === 'number' &&
        Number.isFinite((parsed as Partial<StoredFreshnessState>).refreshedAtMs)
      ) {
        const state: StoredFreshnessState = {
          freshUntilMs: (parsed as StoredFreshnessState).freshUntilMs,
          refreshedAtMs: (parsed as StoredFreshnessState).refreshedAtMs,
        };
        memoryFreshness = state;
        return state;
      }
      return null;
    } catch {
      // Fallback sang bộ nhớ tab hiện tại nếu trình duyệt chặn localStorage.
    }
  }
  return memoryFreshness;
}

function writeFreshnessState(state: StoredFreshnessState): void {
  memoryFreshness = state;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(AUTH_FRESHNESS_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Bỏ qua lỗi ghi localStorage; vẫn giữ được trong bộ nhớ tab hiện tại.
    }
  }
}

/**
 * Ghi nhận mốc Access Token vừa được cấp mới (chỉ lưu timestamp dự kiến, tuyệt đối không lưu token/PII).
 */
export function markAccessTokenFresh(
  ttlMs: number = ACCESS_TOKEN_TTL_MS,
  nowMs: number = Date.now(),
): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return;
  }
  const clampedTtl = Math.min(ttlMs, ACCESS_TOKEN_TTL_MS);
  writeFreshnessState({
    freshUntilMs: nowMs + clampedTtl,
    refreshedAtMs: nowMs,
  });
}

/**
 * Khởi tạo mốc hết hạn dự kiến từ thời gian sống còn lại do SSR trả xuống (miễn nhiễm lệch đồng hồ client-server).
 */
export function seedAccessTokenFreshness(remainingMs: number, nowMs: number = Date.now()): void {
  if (!Number.isFinite(remainingMs) || remainingMs < 0) {
    return;
  }
  const clampedRemaining = Math.min(remainingMs, ACCESS_TOKEN_TTL_MS);
  const candidateFreshUntilMs = nowMs + clampedRemaining;
  const existing = readFreshnessState();

  // Nếu tab khác vừa làm mới phiên thành công trong lúc HTML SSR đang truyền tải,
  // giữ mốc mới hơn để không ghi đè lùi về thời hạn cũ.
  if (
    existing &&
    existing.refreshedAtMs > 0 &&
    nowMs - existing.refreshedAtMs < RECENT_CROSS_TAB_REFRESH_WINDOW_MS &&
    existing.freshUntilMs > candidateFreshUntilMs
  ) {
    return;
  }

  writeFreshnessState({
    freshUntilMs: candidateFreshUntilMs,
    refreshedAtMs: existing?.refreshedAtMs ?? 0,
  });
}

/**
 * Xóa dấu mốc thời hạn Access Token khi đăng xuất hoặc khi phiên đã bị thu hồi.
 */
export function clearAccessTokenFreshness(): void {
  memoryFreshness = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(AUTH_FRESHNESS_STORAGE_KEY);
    } catch {
      // Bỏ qua lỗi khi không truy cập được localStorage.
    }
  }
}

/**
 * Kiểm tra xem Access Token hiện tại đã sắp đến hạn (còn <= `leadMs`) hay đã quá hạn dự kiến chưa.
 */
export function isAccessTokenExpiringSoon(
  leadMs: number = PROACTIVE_REFRESH_LEAD_MS,
  nowMs: number = Date.now(),
): boolean {
  const state = readFreshnessState();
  if (!state) {
    return false;
  }
  return state.freshUntilMs - nowMs <= leadMs;
}

async function withCrossTabRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    let lockEntered = false;
    try {
      return await navigator.locks.request(AUTH_REFRESH_LOCK_NAME, async () => {
        lockEntered = true;
        return task();
      });
    } catch (error) {
      if (lockEntered) {
        throw error;
      }
    }
  }
  return task();
}

/**
 * Đọc mã Double-Submit CSRF Token từ `document.cookie` phía trình duyệt.
 * Tự động ưu tiên tên cookie Production (`__Host-tomato_csrf`) rồi mới tới Local HTTP (`tomato_csrf`).
 */
export function getCsrfTokenFromDocumentCookie(
  rawCookie: string = typeof document !== 'undefined' ? document.cookie : '',
): string | null {
  if (!rawCookie) {
    return null;
  }

  const parsed = new Map<string, string>();
  for (const part of rawCookie.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    try {
      parsed.set(name, decodeURIComponent(value));
    } catch {
      parsed.set(name, value);
    }
  }

  for (const cookieName of CSRF_COOKIE_NAMES) {
    const token = parsed.get(cookieName);
    if (token && token.length > 0) {
      return token;
    }
  }

  return null;
}

/**
 * Chặn lỗ hổng Open Redirect cho tham số `?next=`:
 * chỉ chấp nhận đường dẫn tương đối nội bộ bắt đầu bằng đúng 1 dấu `/` (cấm `//`, `\`, scheme lạ).
 */
export function sanitizeRedirectPath(rawPath: string | null | undefined, fallback = '/'): string {
  if (!rawPath) {
    return fallback;
  }

  const trimmed = rawPath.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    CONTROL_CHARS_REGEX.test(trimmed)
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed, 'https://tomato.local');
    if (parsed.origin !== 'https://tomato.local') {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export interface RefreshAuthSessionOptions {
  /**
   * Nếu một tab khác đã làm mới phiên thành công tại hoặc sau mốc thời gian này (epoch ms),
   * bỏ qua gọi lại `/refresh` để tránh va chạm Refresh Token Rotation liên-tab.
   */
  readonly skipIfRefreshedSinceMs?: number;
  /**
   * Khi bật (`true`), sau khi vào khóa liên-tab sẽ kiểm tra lại xem Access Token đã còn tươi chưa;
   * nếu tab khác vừa làm mới xong thì kết thúc ngay mà không gửi request thừa.
   */
  readonly onlyIfExpiringSoon?: boolean;
}

/**
 * Gọi `POST /api/v1/auth/refresh` với khóa Single-Flight nội-tab kết hợp Web Locks liên-tab (`navigator.locks`):
 * - Nhiều yêu cầu song song trong cùng tab hay nhiều tab mở đồng thời chỉ gửi DUY NHẤT 1 lệnh `/refresh`,
 *   ngăn chặn hoàn toàn nguy cơ tự kích hoạt Refresh Token Reuse Detection.
 */
export async function refreshAuthSession(
  options: RefreshAuthSessionOptions = {},
): Promise<boolean> {
  if (options.onlyIfExpiringSoon && !isAccessTokenExpiringSoon()) {
    return true;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = withCrossTabRefreshLock(async () => {
    const latestState = readFreshnessState();
    const nowMs = Date.now();

    if (
      options.onlyIfExpiringSoon &&
      latestState !== null &&
      latestState.freshUntilMs - nowMs > PROACTIVE_REFRESH_LEAD_MS
    ) {
      return true;
    }

    if (
      typeof options.skipIfRefreshedSinceMs === 'number' &&
      latestState !== null &&
      latestState.refreshedAtMs >= options.skipIfRefreshedSinceMs
    ) {
      return true;
    }

    const csrfToken = getCsrfTokenFromDocumentCookie();
    if (!csrfToken) {
      return false;
    }

    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-CSRF-Token': csrfToken,
        },
      });
      if (response.ok) {
        markAccessTokenFresh();
        return true;
      }
      if (response.status === 401) {
        clearAccessTokenFreshness();
      }
      return false;
    } catch {
      return false;
    }
  }).finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export interface AuthFetchOptions {
  /** Tự động gọi `/api/v1/auth/refresh` và thử lại 1 lần khi nhận `401` (mặc định `true`). */
  readonly retryOnUnauthorized?: boolean;
  /** Chủ động làm mới phiên trước khi Access Token sắp hết hạn 15 phút để tránh nhịp `401` (mặc định `true`). */
  readonly proactiveRefresh?: boolean;
}

/**
 * Wrapper `fetch` cho toàn bộ API cần phiên đăng nhập phía Web Client:
 * - Tự động gửi cookie cùng origin (`credentials: 'same-origin'`).
 * - Tự động đính header `X-CSRF-Token` cho các phương thức thay đổi dữ liệu (`POST`/`PUT`/`PATCH`/`DELETE`).
 * - Chủ động làm mới phiên trước hạn 90 giây qua khóa liên-tab để tránh `401` trên Console,
 *   và vẫn giữ fallback tự retry 1 lần khi gặp `401` thật.
 */
export async function authFetch(
  input: string,
  init: RequestInit = {},
  options: AuthFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryOnUnauthorized = options.retryOnUnauthorized ?? true;
  const proactiveRefresh = options.proactiveRefresh ?? true;

  let attemptedRefresh = false;
  if (retryOnUnauthorized && proactiveRefresh && isAccessTokenExpiringSoon()) {
    attemptedRefresh = true;
    await refreshAuthSession({ onlyIfExpiringSoon: true });
  }

  const buildInit = (): RequestInit => {
    const headers = new Headers(init.headers);
    if (MUTATING_METHODS.has(method) && !headers.has('X-CSRF-Token')) {
      const csrfToken = getCsrfTokenFromDocumentCookie();
      if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
      }
    }
    return {
      ...init,
      credentials: 'same-origin',
      headers,
    };
  };

  const requestStartedAtMs = Date.now();
  const firstResponse = await fetch(input, buildInit());
  if (firstResponse.status !== 401 || !retryOnUnauthorized || attemptedRefresh) {
    return firstResponse;
  }

  const refreshed = await refreshAuthSession({
    skipIfRefreshedSinceMs: requestStartedAtMs,
  });
  if (!refreshed) {
    return firstResponse;
  }

  return fetch(input, buildInit());
}
