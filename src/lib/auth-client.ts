const CSRF_COOKIE_NAMES = ['__Host-tomato_csrf', 'tomato_csrf'] as const;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;

let refreshInFlight: Promise<boolean> | null = null;

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

/**
 * Gọi `POST /api/v1/auth/refresh` với khóa Single-Flight Promise:
 * nếu nhiều yêu cầu song song (ví dụ `/me` và `/sessions`) cùng gặp `401` khi Access Token
 * vừa hết hạn 15 phút, chỉ duy nhất 1 request `/refresh` được gửi để tránh tự kích hoạt
 * Refresh Token Reuse Detection.
 */
export async function refreshAuthSession(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
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
      return response.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export interface AuthFetchOptions {
  /** Tự động gọi `/api/v1/auth/refresh` và thử lại 1 lần khi nhận `401` (mặc định `true`). */
  readonly retryOnUnauthorized?: boolean;
}

/**
 * Wrapper `fetch` cho toàn bộ API cần phiên đăng nhập phía Web Client:
 * - Tự động gửi cookie cùng origin (`credentials: 'same-origin'`).
 * - Tự động đính header `X-CSRF-Token` cho các phương thức thay đổi dữ liệu (`POST`/`PUT`/`PATCH`/`DELETE`).
 * - Tự động làm mới phiên bằng Single-Flight lock khi gặp `401`.
 */
export async function authFetch(
  input: string,
  init: RequestInit = {},
  options: AuthFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryOnUnauthorized = options.retryOnUnauthorized ?? true;

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

  const firstResponse = await fetch(input, buildInit());
  if (firstResponse.status !== 401 || !retryOnUnauthorized) {
    return firstResponse;
  }

  const refreshed = await refreshAuthSession();
  if (!refreshed) {
    return firstResponse;
  }

  return fetch(input, buildInit());
}
