export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;
export const BIO_MAX_LENGTH = 160;
export const BIO_MAX_LINES = 4;
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 64;
export const SEARCH_RESULT_MAX_LIMIT = 20;

export const HANDLE_ALLOWED_REGEX = /^[a-z0-9._]+$/;
const WHITESPACE_REGEX = /\s/;

// Chặn ký tự điều khiển ASCII và ký tự đổi chiều văn bản Bidi/RTL override nguy hiểm (OWASP XSS / UI spoofing).
export const UNSAFE_SINGLE_LINE_CHARS_REGEX =
  /[\u0000-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
export const UNSAFE_MULTILINE_CHARS_REGEX =
  /[\u0000-\u0009\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Danh sách từ khóa hệ thống dành riêng (hợp nhất Giai đoạn 1 + Giai đoạn 2)
 * nhằm chống giả mạo và tránh xung đột đường dẫn ứng dụng.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'auth',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'settings',
  'security',
  'profile',
  'account',
  'privacy',
  'devices',
  'messages',
  'message',
  'chat',
  'calls',
  'call',
  'explore',
  'search',
  'notifications',
  'notification',
  'home',
  'feed',
  'u',
  'user',
  'users',
  'me',
  'media',
  'uploads',
  'static',
  'assets',
  'health',
  'status',
  'verify-email',
  'verify_email',
  'forgot-password',
  'reset-password',
  'support',
  'help',
  'system',
  'root',
  'tomato',
  'official',
  'moderator',
  'mod',
  'staff',
  'null',
  'undefined',
]);

/**
 * Chuẩn hóa `@user_id`: NFKC -> gỡ tối đa 1 dấu `@` đầu -> chữ thường.
 * Không tự ý xóa khoảng trắng bên trong để tầng validation báo lỗi rõ ràng.
 */
export function normalizeHandle(rawHandle: string): string {
  const nfkc = rawHandle.normalize('NFKC');
  const withoutLeadingAt = nfkc.startsWith('@') ? nfkc.slice(1) : nfkc;
  return withoutLeadingAt.toLowerCase();
}

export type HandleValidationErrorCode =
  | 'REQUIRED'
  | 'NO_SPACES'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_CHARS'
  | 'INVALID_DOTS'
  | 'RESERVED';

export type HandleValidationResult =
  | { readonly valid: true; readonly normalized: string }
  | { readonly valid: false; readonly code: HandleValidationErrorCode };

export function validateNormalizedHandle(rawHandle: string): HandleValidationResult {
  const normalized = normalizeHandle(rawHandle);
  if (normalized.length === 0) {
    return { valid: false, code: 'REQUIRED' };
  }
  if (WHITESPACE_REGEX.test(normalized)) {
    return { valid: false, code: 'NO_SPACES' };
  }
  if (normalized.length < HANDLE_MIN_LENGTH) {
    return { valid: false, code: 'TOO_SHORT' };
  }
  if (normalized.length > HANDLE_MAX_LENGTH) {
    return { valid: false, code: 'TOO_LONG' };
  }
  if (!HANDLE_ALLOWED_REGEX.test(normalized)) {
    return { valid: false, code: 'INVALID_CHARS' };
  }
  if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
    return { valid: false, code: 'INVALID_DOTS' };
  }
  if (RESERVED_HANDLES.has(normalized)) {
    return { valid: false, code: 'RESERVED' };
  }
  return { valid: true, normalized };
}

export function isReservedHandle(rawHandle: string): boolean {
  return RESERVED_HANDLES.has(normalizeHandle(rawHandle));
}

/**
 * Chuẩn hóa chuỗi tiểu sử (`bio`): NFKC, chuẩn hóa xuống dòng `\r\n`/`\r` -> `\n` và trim đầu/cuối.
 */
export function normalizeBio(rawBio: string): string {
  return rawBio.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

/**
 * Chuẩn hóa từ khóa tìm kiếm: NFKC, xóa ký tự điều khiển/Bidi, trim, gỡ dấu `@` ở đầu (nếu có).
 */
export function normalizeSearchQuery(rawQuery: string): string {
  const cleaned = rawQuery
    .normalize('NFKC')
    .replace(new RegExp(UNSAFE_SINGLE_LINE_CHARS_REGEX.source, 'g'), '')
    .trim();
  const withoutLeadingAt = cleaned.startsWith('@') ? cleaned.slice(1).trim() : cleaned;
  return withoutLeadingAt;
}

/**
 * Escape ký tự đại diện SQL `LIKE`/`ILIKE` (`\`, `%`, `_`) để chống wildcard injection / DoS.
 */
export function escapeSqlLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
