import 'server-only';

import type { NextResponse } from 'next/server';

import { getEnv } from '@/core/config/env';
import { timingSafeEqualUtf8 } from '@/core/crypto/token';
import {
  getCookieFromRequest,
  getCookieNames,
  isProductionCookieEnv,
} from '@/core/security/cookies';
import { createErrorResponse, type ApiErrorPayload } from '@/core/security/http-response';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIN_CSRF_TOKEN_LENGTH = 32;

export const CSRF_HEADER_NAME = 'x-csrf-token';

export type CsrfFailureReason =
  | 'SEC_FETCH_SITE_REJECTED'
  | 'MISSING_ORIGIN'
  | 'INVALID_ORIGIN'
  | 'ORIGIN_MISMATCH'
  | 'MISSING_CSRF_TOKEN'
  | 'INVALID_CSRF_TOKEN'
  | 'CSRF_TOKEN_MISMATCH';

export type CsrfVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: CsrfFailureReason;
      readonly message: string;
    };

export interface VerifyCsrfOptions {
  /** Danh sách Origin hợp lệ (mặc định đọc từ `env.ALLOWED_ORIGINS`). */
  readonly allowedOrigins?: readonly string[];
  /** Mặc định fail-closed bắt buộc kiểm tra Double-Submit CSRF Token (`X-CSRF-Token` vs cookie). */
  readonly requireDoubleSubmit?: boolean;
  /** Ghi đè trạng thái production (ảnh hưởng tên cookie `__Host-tomato_csrf` vs `tomato_csrf`). */
  readonly isProduction?: boolean;
}

function normalizeOrigin(rawOrigin: string): string | null {
  if (!rawOrigin || rawOrigin === 'null') {
    return null;
  }
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Phòng thủ CSRF đa lớp cho mọi request thay đổi dữ liệu (`POST`, `PUT`, `PATCH`, `DELETE`):
 * 1. Kiểm tra `Sec-Fetch-Site` chặn tuyệt đối request `cross-site` hoặc điều hướng trực tiếp `none`.
 * 2. Kiểm tra chặt `Origin` phải khớp danh sách `ALLOWED_ORIGINS` (fail-closed khi thiếu).
 * 3. Kiểm tra Double-Submit CSRF Token: so sánh header `X-CSRF-Token` với cookie CSRF bằng `timingSafeEqual`.
 */
export function verifyCsrfAndOrigin(
  request: Request,
  options: VerifyCsrfOptions = {},
): CsrfVerificationResult {
  const method = request.method.toUpperCase();
  if (SAFE_HTTP_METHODS.has(method)) {
    return { valid: true };
  }

  // Lớp 1: Kiểm tra Fetch Metadata (`Sec-Fetch-Site`) nếu trình duyệt gửi kèm.
  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== '') {
    if (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
      return {
        valid: false,
        reason: 'SEC_FETCH_SITE_REJECTED',
        message: 'Yêu cầu bị từ chối do nguồn gọi không cùng ngữ cảnh tin cậy.',
      };
    }
  }

  // Lớp 2: Kiểm tra `Origin` bắt buộc tồn tại và nằm trong `ALLOWED_ORIGINS`.
  const rawOrigin = request.headers.get('origin')?.trim();
  if (!rawOrigin) {
    return {
      valid: false,
      reason: 'MISSING_ORIGIN',
      message: 'Thiếu header Origin hợp lệ cho yêu cầu thay đổi dữ liệu.',
    };
  }

  const normalizedOrigin = normalizeOrigin(rawOrigin);
  if (!normalizedOrigin) {
    return {
      valid: false,
      reason: 'INVALID_ORIGIN',
      message: 'Header Origin không hợp lệ.',
    };
  }

  const allowedOrigins = options.allowedOrigins ?? getEnv().ALLOWED_ORIGINS;
  const normalizedAllowedSet = new Set(
    allowedOrigins.map((origin) => normalizeOrigin(origin)).filter((v): v is string => v !== null),
  );

  if (!normalizedAllowedSet.has(normalizedOrigin)) {
    return {
      valid: false,
      reason: 'ORIGIN_MISMATCH',
      message: 'Nguồn yêu cầu (Origin) không được phép truy cập.',
    };
  }

  // Lớp 3: Double-Submit CSRF Token (mặc định fail-closed).
  const requireDoubleSubmit = options.requireDoubleSubmit ?? true;
  if (!requireDoubleSubmit) {
    return { valid: true };
  }

  const isProduction = options.isProduction ?? isProductionCookieEnv();
  const { csrfToken: csrfCookieName } = getCookieNames(isProduction);

  const headerToken = request.headers.get(CSRF_HEADER_NAME)?.trim();
  const cookieToken = getCookieFromRequest(request, csrfCookieName)?.trim();

  if (!headerToken || !cookieToken) {
    return {
      valid: false,
      reason: 'MISSING_CSRF_TOKEN',
      message: 'Thiếu mã xác thực chống giả mạo yêu cầu (CSRF token).',
    };
  }

  if (headerToken.length < MIN_CSRF_TOKEN_LENGTH || cookieToken.length < MIN_CSRF_TOKEN_LENGTH) {
    return {
      valid: false,
      reason: 'INVALID_CSRF_TOKEN',
      message: 'Mã xác thực chống giả mạo yêu cầu (CSRF token) không hợp lệ.',
    };
  }

  if (!timingSafeEqualUtf8(headerToken, cookieToken)) {
    return {
      valid: false,
      reason: 'CSRF_TOKEN_MISMATCH',
      message: 'Mã xác thực chống giả mạo yêu cầu (CSRF token) không khớp.',
    };
  }

  return { valid: true };
}

/**
 * Helper dùng trong Route Handlers: trả về `403 Forbidden` chuẩn hóa nếu kiểm tra CSRF thất bại,
 * ngược lại trả `null` để tiếp tục xử lý nghiệp vụ.
 */
export function enforceCsrfAndOrigin(
  request: Request,
  options: VerifyCsrfOptions = {},
): NextResponse<ApiErrorPayload> | null {
  const result = verifyCsrfAndOrigin(request, options);
  if (result.valid) {
    return null;
  }

  return createErrorResponse({
    status: 403,
    code: 'CSRF_VALIDATION_FAILED',
    message: result.message,
  });
}
