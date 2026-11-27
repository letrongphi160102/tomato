export const UI_PREFS_COOKIE_NAME = 'tomato_ui_prefs';
export const UI_PREFS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const UI_THEME_MODES = ['light', 'dark', 'system'] as const;
export type UiThemeMode = (typeof UI_THEME_MODES)[number];
export type ResolvedUiTheme = 'light' | 'dark';

export interface UiPreferences {
  readonly theme: UiThemeMode;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = Object.freeze({
  theme: 'light',
});

// Hỗ trợ đọc cả định dạng gọn `light|dark|system` lẫn cookie cũ `dark.0.1` để không mất lựa chọn hiện tại của trình duyệt.
const UI_PREFS_COOKIE_REGEX = /^(light|dark|system)(?:\.[01]\.[01])?$/;

export function isValidUiThemeMode(value: unknown): value is UiThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Giải mã giá trị cookie `tomato_ui_prefs` (`light` | `dark` | `system`).
 * Mọi giá trị rỗng, sai cấu trúc hoặc chứa ký tự lạ đều trả về `DEFAULT_UI_PREFERENCES` (`light`).
 */
export function parseUiPreferencesCookie(rawValue: string | null | undefined): UiPreferences {
  if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue.length > 32) {
    return DEFAULT_UI_PREFERENCES;
  }

  let decoded = rawValue.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }

  const match = UI_PREFS_COOKIE_REGEX.exec(decoded);
  if (!match) {
    return DEFAULT_UI_PREFERENCES;
  }

  return {
    theme: match[1] as UiThemeMode,
  };
}

/**
 * Tuần tự hóa chế độ màu sang chuỗi enum cố định (`light` | `dark` | `system`, không chứa PII).
 */
export function serializeUiPreferencesCookie(prefs: UiPreferences): string {
  return isValidUiThemeMode(prefs.theme) ? prefs.theme : DEFAULT_UI_PREFERENCES.theme;
}

/**
 * Tạo chuỗi gán `document.cookie` tuân thủ `SameSite=Lax; Path=/` (tự bật `Secure` khi chạy HTTPS).
 */
export function buildUiPreferencesSetCookieString(
  prefs: UiPreferences,
  options: { readonly isHttps?: boolean; readonly maxAgeSeconds?: number } = {},
): string {
  const encoded = serializeUiPreferencesCookie(prefs);
  const maxAge = options.maxAgeSeconds ?? UI_PREFS_MAX_AGE_SECONDS;
  const parts = [
    `${UI_PREFS_COOKIE_NAME}=${encoded}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    'SameSite=Lax',
  ];
  if (options.isHttps) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function readUiPreferencesFromCookieHeader(
  rawCookieHeader: string | null | undefined,
): UiPreferences {
  if (!rawCookieHeader) {
    return DEFAULT_UI_PREFERENCES;
  }

  for (const segment of rawCookieHeader.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = segment.slice(0, eqIndex).trim();
    if (name === UI_PREFS_COOKIE_NAME) {
      return parseUiPreferencesCookie(segment.slice(eqIndex + 1).trim());
    }
  }

  return DEFAULT_UI_PREFERENCES;
}
