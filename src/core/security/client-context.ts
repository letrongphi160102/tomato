import 'server-only';

import { normalizeIpAddress } from '@/core/security/audit-log.service';

export interface RequestClientContext {
  /** IP hợp lệ cho cột PostgreSQL INET (null nếu không trích xuất được IP chuẩn). */
  readonly ipAddress: string | null;
  /** Khóa định danh IP an toàn cho Rate Limiter (không bao giờ rỗng). */
  readonly rateLimitIpKey: string;
  readonly userAgent: string | null;
}

/**
 * Trích xuất ngữ cảnh client từ HTTP headers chuẩn hóa trên cả Vercel/Cloudflare và môi trường local.
 * Ưu tiên `x-real-ip` / `cf-connecting-ip` / phần tử đầu tiên của `x-forwarded-for`,
 * luôn kiểm tra bằng `normalizeIpAddress` để tránh giả mạo ký tự lạ vào cột INET hoặc khóa Redis.
 */
export function extractRequestClientContext(request: Request): RequestClientContext {
  const candidates = [
    request.headers.get('cf-connecting-ip'),
    request.headers.get('x-real-ip'),
    request.headers.get('x-forwarded-for'),
  ];

  let ipAddress: string | null = null;
  for (const candidate of candidates) {
    const normalized = normalizeIpAddress(candidate);
    if (normalized) {
      ipAddress = normalized;
      break;
    }
  }

  const rawUserAgent = request.headers.get('user-agent')?.trim();
  const userAgent = rawUserAgent && rawUserAgent.length > 0 ? rawUserAgent : null;

  return {
    ipAddress,
    rateLimitIpKey: ipAddress ?? 'unknown',
    userAgent,
  };
}
