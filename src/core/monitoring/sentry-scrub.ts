import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

/**
 * Cấu hình thu thập dữ liệu tối thiểu cho Sentry SDK v11 (Defense-in-Depth lớp 1):
 * tắt thu thập tự động cookie, header, HTTP body, query params, tham số DB và biến cục bộ stack frame
 * ngay từ nguồn, trước khi sự kiện tiếp tục đi qua bộ lọc `beforeSend` / `beforeBreadcrumb` (lớp 2).
 */
export const SENTRY_PRIVACY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
};

const REDACTED = '[REDACTED]';
const MAX_SCRUB_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

// Danh sách mẫu tên khóa nhạy cảm bắt buộc loại bỏ/che hoàn toàn trước khi gửi sự kiện sang Sentry.
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|pass|token|otp|ticket|secret|pepper|cookie|set-cookie|authorization|proxy-authorization|csrf|hash|private[_-]?key|api[_-]?key|api-key|credential|credentials|email|e-mail|phone|dateofbirth|date_of_birth|dob|fullname|full_name|ip_address|ipaddress|x-forwarded-for|x-real-ip|x-vercel-forwarded-for|cf-connecting-ip|dsn|database_url|redis_url|^mac$|ciphertext|crypto[_-]?header|wrapped[_-]?key|encrypted[_-]?key[_-]?blob|kdf[_-]?salt|recovery[_-]?pin|current[_-]?pin|new[_-]?pin|confirm[_-]?pin|^pin$|bootstrap[_-]?key[_-]?pair|private[_-]?jwk|file[_-]?key|file[_-]?iv|client[_-]?token|thumbnail[_-]?data[_-]?url|^sdp$|ice[_-]?servers?|secret[_-]?key|metered[_-]?secret[_-]?key|metered[_-]?turn[_-]?api[_-]?key|ice[_-]?candidate|^candidate$|turn[_-]?password)/i;

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'api-key',
  'x-api-key',
  'x-forwarded-for',
  'x-real-ip',
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
]);

// Phòng thủ chiều sâu: lọc chuỗi chứa JWT, Bearer, Argon2 hash, cookie phiên TOMATO,
// connection string DB/Redis, tham số truy vấn Drizzle (`params: ...`), xác thực SMTP,
// JSON/header nhạy cảm, query param nhạy cảm (ví dụ `/reset-password?token=...`) và email PII.
const BEARER_REGEX = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const THIRD_PARTY_WEBVIEW_NOISE_REGEX =
  /\b(?:zaloJSV2|WeixinJSBridge|__gCrWeb|fb_xd_fragment)\s+is\s+not\s+defined\b/i;

/**
 * Phát hiện các lỗi ReferenceError ngoại lai do In-App WebView của ứng dụng bên thứ ba
 * (như Zalo WebView `zaloJSV2 is not defined`, WeChat `WeixinJSBridge`) tự tiêm script vào trang.
 */
export function isThirdPartyBrowserNoiseEvent(event: ErrorEvent): boolean {
  if (typeof event.message === 'string' && THIRD_PARTY_WEBVIEW_NOISE_REGEX.test(event.message)) {
    return true;
  }
  const values = event.exception?.values;
  if (Array.isArray(values)) {
    for (const ex of values) {
      if (typeof ex.value === 'string' && THIRD_PARTY_WEBVIEW_NOISE_REGEX.test(ex.value)) {
        return true;
      }
    }
  }
  return false;
}
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ARGON2_HASH_REGEX = /\$argon2(?:id|i|d)\$[^\s"'`]+/gi;
const TOMATO_COOKIE_REGEX = /\b(?:__Host-)?tomato_(?:at|rt|csrf|pwd_ticket)=[^;\s"'`]+/gi;
const CONNECTION_URL_REGEX = /\b(?:postgres(?:ql)?|rediss?):\/\/[^\s"'`]+/gi;
const DRIZZLE_PARAMS_REGEX = /(\bparams:\s*)[^\r\n]+/gi;
const SMTP_AUTH_REGEX = /\b(AUTH\s+(?:PLAIN|LOGIN))\s+[^\r\n]+/gi;
const INLINE_JSON_SECRET_REGEX =
  /("(?:password|currentPassword|newPassword|confirmPassword|passwd|pwd|otp|otpCode|otp_code|pin|recoveryPin|currentPin|current_pin|newPin|new_pin|confirmPin|confirm_pin|token|accessToken|access_token|refreshToken|refresh_token|csrfToken|csrf_token|captchaToken|captcha_token|resetToken|reset_token|ticket|passwordChangeTicket|secret|secretKey|secret_key|pepper|apiKey|api_key|api-key|credential|credentials|turnPassword|turn_password|sdp|candidate|iceCandidate|ice_candidate|meteredSecretKey|meteredTurnApiKey|cookie|authorization|fileKey|file_key|fileIv|file_iv|clientToken|client_token|thumbnailDataUrl|thumbnail_data_url)"\s*:\s*)"[^"]*"/gi;
const INLINE_SECRET_HEADER_REGEX =
  /\b(Cookie|Set-Cookie|X-CSRF-Token|Authorization|Proxy-Authorization|Api-Key|X-Api-Key)\s*:\s*[^\r\n|]+/gi;
const SENSITIVE_QUERY_PARAM_REGEX =
  /([?&](?:token|reset_token|access_token|refresh_token|otp|otpCode|otp_code|pin|currentPin|newPin|code|password|currentPassword|newPassword|passwd|pwd|ticket|csrf|csrfToken|csrf_token|secret|secretKey|secret_key|pepper|key|apiKey|api_key|api-key|authorization|email|captchaToken|captcha_token)=)[^&#\s"'`]+/gi;
const EMAIL_ADDRESS_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Trích xuất đúng `origin` HTTPS của Sentry ingest từ DSN để thêm chọn lọc vào CSP `connect-src`,
 * tránh mở rộng wildcard `https:` gây suy giảm lớp bảo vệ XSS exfiltration.
 */
export function extractSentryIngestOrigin(rawDsn?: string | null): string | null {
  if (!rawDsn) {
    return null;
  }
  const trimmed = rawDsn.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Che mọi mẩu dữ liệu nhạy cảm & PII xuất hiện trong chuỗi tự do (URL, message, stack message, JSON string).
 */
export function scrubSensitiveString(raw: string): string {
  return raw
    .replace(BEARER_REGEX, 'Bearer [REDACTED]')
    .replace(JWT_REGEX, '[REDACTED_JWT]')
    .replace(ARGON2_HASH_REGEX, '[REDACTED_HASH]')
    .replace(TOMATO_COOKIE_REGEX, '[REDACTED_COOKIE]')
    .replace(CONNECTION_URL_REGEX, '[REDACTED_URL]')
    .replace(DRIZZLE_PARAMS_REGEX, '$1[REDACTED]')
    .replace(SMTP_AUTH_REGEX, '$1 [REDACTED]')
    .replace(INLINE_JSON_SECRET_REGEX, '$1"[REDACTED]"')
    .replace(INLINE_SECRET_HEADER_REGEX, '$1: [REDACTED]')
    .replace(SENSITIVE_QUERY_PARAM_REGEX, '$1[REDACTED]')
    .replace(EMAIL_ADDRESS_REGEX, '[REDACTED_EMAIL]');
}

function scrubValueInternal(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    // Nếu body là JSON string (ví dụ `event.request.data`), thử phân tích để redact từng khóa nhạy cảm.
    const trimmed = value.trim();
    if (
      depth <= 2 &&
      ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const scrubbed = scrubValueInternal(parsed, depth + 1, seen);
        return JSON.stringify(scrubbed);
      } catch {
        // Không phải JSON hợp lệ — rơi xuống lọc theo biểu thức chuỗi.
      }
    }
    return scrubSensitiveString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= MAX_SCRUB_DEPTH) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubValueInternal(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(record)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        clean[key] = REDACTED;
      } else {
        clean[key] = scrubValueInternal(nestedValue, depth + 1, seen);
      }
    }
    return clean;
  }

  return undefined;
}

export function scrubSensitiveValue(value: unknown): unknown {
  return scrubValueInternal(value, 0, new WeakSet<object>());
}

function scrubHeadersRecord(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key)) {
      clean[key] = REDACTED;
    } else {
      clean[key] = scrubSensitiveString(String(val));
    }
  }
  return clean;
}

/**
 * Bộ lọc `beforeBreadcrumb` dùng chung cho Client, Server và Edge:
 * ngăn URL mang reset token, header auth hay payload nhạy cảm lọt vào lịch sử breadcrumb.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = { ...breadcrumb };

  if (typeof next.message === 'string') {
    next.message = scrubSensitiveString(next.message);
  }

  if (next.data && typeof next.data === 'object') {
    next.data = scrubSensitiveValue(next.data) as Record<string, unknown>;
  }

  return next;
}

/**
 * Bộ lọc `beforeSend` dùng chung cho Client, Server và Edge (M5):
 * - Xóa hoàn toàn `request.cookies` và che mọi header xác thực/IP (`Cookie`, `Authorization`, `X-CSRF-Token`, `X-Forwarded-For`).
 * - Lọc sạch token trong URL/query string (`/reset-password?token=...`), mật khẩu/OTP trong `request.data`, `extra`, `contexts`, `tags`.
 * - Xóa toàn bộ PII người dùng (`user.email`, `user.ip_address`, `user.username`, `user.name`).
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event };

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = scrubSensitiveString(scrubbed.message);
  }

  if (typeof scrubbed.transaction === 'string') {
    scrubbed.transaction = scrubSensitiveString(scrubbed.transaction);
  }

  if (scrubbed.logentry) {
    scrubbed.logentry = {
      ...scrubbed.logentry,
      ...(typeof scrubbed.logentry.message === 'string'
        ? { message: scrubSensitiveString(scrubbed.logentry.message) }
        : {}),
      ...(scrubbed.logentry.params !== undefined
        ? {
            params: scrubSensitiveValue(
              scrubbed.logentry.params,
            ) as typeof scrubbed.logentry.params,
          }
        : {}),
    };
  }

  if (scrubbed.user) {
    const safeUser: Record<string, unknown> = {};
    if (typeof scrubbed.user.id === 'string' && !EMAIL_ADDRESS_REGEX.test(scrubbed.user.id)) {
      safeUser.id = scrubbed.user.id;
    }
    scrubbed.user = Object.keys(safeUser).length > 0 ? safeUser : undefined;
  }

  if (scrubbed.request) {
    const nextRequest = { ...scrubbed.request };
    delete nextRequest.cookies;

    if (nextRequest.headers && typeof nextRequest.headers === 'object') {
      nextRequest.headers = scrubHeadersRecord(nextRequest.headers);
    }

    if (typeof nextRequest.url === 'string') {
      nextRequest.url = scrubSensitiveString(nextRequest.url);
    }

    if (typeof nextRequest.query_string === 'string') {
      const prefixed = nextRequest.query_string.startsWith('?')
        ? nextRequest.query_string
        : `?${nextRequest.query_string}`;
      const cleaned = scrubSensitiveString(prefixed);
      nextRequest.query_string = nextRequest.query_string.startsWith('?')
        ? cleaned
        : cleaned.slice(1);
    } else if (nextRequest.query_string && typeof nextRequest.query_string === 'object') {
      nextRequest.query_string = scrubSensitiveValue(
        nextRequest.query_string,
      ) as typeof nextRequest.query_string;
    }

    if (nextRequest.data !== undefined) {
      nextRequest.data = scrubSensitiveValue(nextRequest.data);
    }

    scrubbed.request = nextRequest;
  }

  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((ex) => {
        const nextStacktrace = ex.stacktrace?.frames
          ? {
              ...ex.stacktrace,
              frames: ex.stacktrace.frames.map((frame) => {
                if (!frame.vars) {
                  return frame;
                }
                const cleanedFrame = { ...frame };
                delete cleanedFrame.vars;
                return cleanedFrame;
              }),
            }
          : ex.stacktrace;

        return {
          ...ex,
          value: typeof ex.value === 'string' ? scrubSensitiveString(ex.value) : ex.value,
          ...(nextStacktrace ? { stacktrace: nextStacktrace } : {}),
        };
      }),
    };
  }

  if (scrubbed.extra) {
    scrubbed.extra = scrubSensitiveValue(scrubbed.extra) as Record<string, unknown>;
  }

  if (scrubbed.contexts) {
    scrubbed.contexts = scrubSensitiveValue(scrubbed.contexts) as typeof scrubbed.contexts;
  }

  if (scrubbed.tags) {
    const cleanTags: Record<string, string | number | boolean> = {};
    for (const [key, val] of Object.entries(scrubbed.tags)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        cleanTags[key] = REDACTED;
      } else if (typeof val === 'string') {
        cleanTags[key] = scrubSensitiveString(val);
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        cleanTags[key] = val;
      }
    }
    scrubbed.tags = cleanTags;
  }

  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((crumb) => scrubSentryBreadcrumb(crumb));
  }

  return scrubbed;
}
