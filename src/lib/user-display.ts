/**
 * Tiện ích hiển thị thuần túy (dùng chung an toàn cho cả Server Component lẫn Client Component,
 * tuyệt đối không đặt trong file `'use client'` để tránh lỗi RSC client-reference proxy).
 */
export function getUserInitials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'T';
  }
  if (parts.length === 1) {
    return (parts[0] ?? 'T').slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || 'T';
}
