/**
 * Chuẩn hóa email trước khi lưu hoặc tra cứu để tránh trùng lặp qua ký tự Unicode tương đương
 * (ví dụ ký tự full-width hoặc chữ hoa/thường khác nhau).
 */
export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().normalize('NFKC').toLowerCase();
}

/**
 * Chuẩn hóa mật khẩu theo Unicode NFKC theo khuyến nghị NIST SP 800-63B.
 * Tuyệt đối KHÔNG gọi `.trim()` vì khoảng trắng đầu/cuối là ký tự hợp lệ của mật khẩu.
 */
export function normalizePassword(rawPassword: string): string {
  return rawPassword.normalize('NFKC');
}
