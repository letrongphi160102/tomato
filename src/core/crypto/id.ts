import 'server-only';

import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

/**
 * Sinh UUIDv7 tăng dần theo thời gian cho khóa chính nội bộ (`id`) nhằm giữ B-Tree index tối ưu.
 * Tuyệt đối KHÔNG trả giá trị này ra API hoặc URL công khai.
 */
export function generateUuidV7(): string {
  return uuidv7();
}

/**
 * Sinh UUIDv4 ngẫu nhiên mật mã học (CSPRNG, 36 ký tự khớp VARCHAR(36)) cho `public_id`
 * để trả ra API/URL mà không lộ thứ tự tạo hay quy mô hệ thống.
 */
export function generatePublicId(): string {
  return randomUUID();
}
