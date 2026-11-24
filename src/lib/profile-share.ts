/**
 * Tạo đường dẫn chia sẻ chuẩn cho trang cá nhân `/u/[handle]`.
 * Tách khỏi file `'use client'` để có thể dùng an toàn ở cả Server lẫn Client Component.
 */
export function buildProfileShareUrl(origin: string, handle: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  return `${cleanOrigin}/u/${encodeURIComponent(handle)}`;
}
