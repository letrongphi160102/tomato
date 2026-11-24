import 'server-only';

import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';

export const AUTH_CACHE_CONTROL_HEADER = 'no-store, max-age=0';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CSRF_VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_INVALID'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'CHAT_PENDING_TEXT_ONLY'
  | 'CHAT_PENDING_LIMIT_REACHED'
  | 'CHAT_SELF_CONVERSATION_FORBIDDEN'
  | 'CHAT_MESSAGE_EDIT_WINDOW_EXPIRED'
  | 'CHAT_MESSAGE_RECALL_WINDOW_EXPIRED'
  | 'CHAT_MESSAGE_EDIT_LIMIT_REACHED'
  | 'CHAT_MESSAGE_ALREADY_RECALLED'
  | 'CHAT_MESSAGE_EDIT_UNSUPPORTED_TYPE'
  | 'INTERNAL_ERROR';

export interface ApiErrorDetail {
  readonly field?: string;
  readonly message: string;
}

export interface ApiErrorPayload {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details: readonly ApiErrorDetail[];
    /** Chỉ xuất hiện khi `true`: báo cho Frontend tự động hiển thị widget Cloudflare Turnstile. */
    readonly requireCaptcha?: true;
  };
}

export interface CreateErrorResponseInput {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
  readonly requireCaptcha?: boolean;
  readonly headers?: HeadersInit;
}

export function applyNoStoreHeaders(headers: Headers): void {
  headers.set('Cache-Control', AUTH_CACHE_CONTROL_HEADER);
  headers.set('Pragma', 'no-cache');
}

/**
 * Tạo HTTP Error Response chuẩn hóa toàn hệ thống (`{ error: { code, message, details } }`)
 * và luôn gắn `Cache-Control: no-store, max-age=0` để ngăn trình duyệt/proxy lưu đệm phản hồi Auth.
 */
export function createErrorResponse(
  input: CreateErrorResponseInput,
): NextResponse<ApiErrorPayload> {
  const headers = new Headers(input.headers);
  applyNoStoreHeaders(headers);

  if (input.retryAfterSeconds !== undefined && input.retryAfterSeconds > 0) {
    headers.set('Retry-After', String(Math.ceil(input.retryAfterSeconds)));
  }

  const payload: ApiErrorPayload = {
    error: {
      code: input.code,
      message: input.message,
      details: input.details ? [...input.details] : [],
      ...(input.requireCaptcha ? { requireCaptcha: true as const } : {}),
    },
  };

  return NextResponse.json(payload, {
    status: input.status,
    headers,
  });
}

/**
 * Tạo HTTP JSON Response thành công cho các API Auth với header `Cache-Control: no-store, max-age=0`.
 */
export function createAuthJsonResponse<T>(
  data: T,
  init: { readonly status?: number; readonly headers?: HeadersInit } = {},
): NextResponse<T> {
  const headers = new Headers(init.headers);
  applyNoStoreHeaders(headers);

  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers,
  });
}

/**
 * Chuyển đổi lỗi Zod sang mảng `details` an toàn (chỉ lấy tên trường và thông điệp,
 * không phản hồi lại giá trị đầu vào nhạy cảm như mật khẩu hay OTP).
 */
export function formatZodErrorDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return field ? { field, message: issue.message } : { message: issue.message };
  });
}
