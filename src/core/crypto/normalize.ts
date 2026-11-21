/**
 * Chuẩn hóa email trước khi lưu hoặc tra cứu để tránh trùng lặp qua ký tự Unicode tương đương
 * (ví dụ ký tự full-width hoặc chữ hoa/thường khác nhau).
 */
export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().normalize('NFKC').toLowerCase();
}

/**
 * Chuẩn hóa ID tài khoản (`@username` giống TikTok/Instagram):
 * chuẩn hóa Unicode NFKC, gỡ 1 dấu `@` ở đầu (nếu người dùng gõ kèm) và chuyển về chữ thường.
 * Không xóa khoảng trắng để tầng validation báo lỗi rõ khi người dùng nhập khoảng trắng.
 */
export function normalizeUsername(rawUsername: string): string {
  const normalized = rawUsername.normalize('NFKC');
  const withoutLeadingAt = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  return withoutLeadingAt.toLowerCase();
}

/**
 * Chuẩn hóa mật khẩu theo Unicode NFKC theo khuyến nghị NIST SP 800-63B.
 * Tuyệt đối KHÔNG gọi `.trim()` vì khoảng trắng đầu/cuối là ký tự hợp lệ của mật khẩu.
 */
export function normalizePassword(rawPassword: string): string {
  return rawPassword.normalize('NFKC');
}
