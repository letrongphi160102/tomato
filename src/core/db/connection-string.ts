const LEGACY_VERIFY_FULL_ALIAS_MODES = new Set(['prefer', 'require', 'verify-ca']);

/**
 * Chuẩn hóa chuỗi kết nối PostgreSQL cho `pg` v8+:
 * - Tự động nâng `sslmode=require` / `prefer` / `verify-ca` thành `sslmode=verify-full`
 *   (giữ nguyên mức xác minh chứng chỉ + hostname mạnh nhất và tắt cảnh báo bảo mật của `pg-connection-string`
 *   khi dùng URL mặc định từ Neon).
 * - Giữ nguyên các URL cục bộ không có `sslmode` (Docker), `sslmode=disable`, `sslmode=verify-full`,
 *   hoặc khi người dùng chủ động bật `uselibpqcompat=true`.
 */
export function normalizePostgresConnectionString(rawConnectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawConnectionString);
  } catch {
    return rawConnectionString;
  }

  const useLibpqCompat = parsed.searchParams.get('uselibpqcompat')?.trim().toLowerCase();
  if (useLibpqCompat === 'true') {
    return rawConnectionString;
  }

  const sslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  if (!sslMode || !LEGACY_VERIFY_FULL_ALIAS_MODES.has(sslMode)) {
    return rawConnectionString;
  }

  parsed.searchParams.set('sslmode', 'verify-full');
  return parsed.toString();
}
