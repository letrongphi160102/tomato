import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { logger } from '@/core/logger';
import { clearAuthCookies } from '@/core/security/cookies';
import {
  createErrorResponse,
  formatZodErrorDetails,
  type ApiErrorPayload,
} from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';

const MAX_AUTH_JSON_BODY_BYTES = 16 * 1024; // 16 KiB đủ cho mọi form Auth, chặn DoS payload lớn.

async function readBoundedTextBody(request: Request): Promise<string> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_AUTH_JSON_BODY_BYTES) {
      throw new AuthDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  // Đọc theo luồng có giới hạn byte để chặn tấn công làm cạn RAM bằng Transfer-Encoding: chunked
  // không khai báo Content-Length.
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_AUTH_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new AuthDomainError({
              status: 413,
              code: 'VALIDATION_ERROR',
              message: AUTH_MESSAGES.payloadTooLarge,
            });
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof AuthDomainError) {
        throw error;
      }
      throw new AuthDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    throw new AuthDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_AUTH_JSON_BODY_BYTES) {
    throw new AuthDomainError({
      status: 413,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.payloadTooLarge,
    });
  }

  return rawText;
}

/**
 * Đọc và phân tích thân JSON bắt buộc của yêu cầu Auth với giới hạn dung lượng nghiêm ngặt.
 */
export async function parseAuthJsonBody(request: Request): Promise<unknown> {
  const rawText = await readBoundedTextBody(request);
  if (!rawText.trim()) {
    throw new AuthDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new AuthDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

/**
 * Đọc và phân tích thân JSON tùy chọn (cho phép rỗng -> `{}` ví dụ `POST /sessions/revoke-all`).
 */
export async function parseOptionalAuthJsonBody(request: Request): Promise<unknown> {
  const rawText = await readBoundedTextBody(request);
  if (!rawText.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new AuthDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

/**
 * Ánh xạ mọi ngoại lệ từ tầng nghiệp vụ Auth/Session sang HTTP Error Response chuẩn hóa
 * kèm `Cache-Control: no-store, max-age=0` và xóa cookie nếu lỗi bảo mật yêu cầu.
 */
export function handleAuthRouteError(
  error: unknown,
  endpoint: string,
): NextResponse<ApiErrorPayload> {
  if (error instanceof AuthDomainError) {
    const response = createErrorResponse({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds,
      requireCaptcha: error.requireCaptcha,
    });

    if (error.clearCookies) {
      clearAuthCookies(response, { clearCsrf: true });
    }

    return response;
  }

  if (error instanceof ZodError) {
    return createErrorResponse({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.validationFailed,
      details: formatZodErrorDetails(error),
    });
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown; readonly name?: unknown })
      : null;
  logger.error(
    {
      component: 'auth-api',
      endpoint,
      errorCode:
        typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
          ? errObj.code
          : 'UNHANDLED_ERROR',
      errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
    },
    'Lỗi không mong đợi tại Auth API endpoint',
  );

  // Chỉ báo cáo lỗi hệ thống 500 thực sự lên Sentry (không gửi lỗi nghiệp vụ 4xx như sai mật khẩu/rate limit).
  // Mọi PII/cookie/token đều đã đi qua bộ lọc `beforeSend` trong `sentry.server.config.ts`.
  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('component', 'auth-api');
      scope.setTag('endpoint', endpoint);
      Sentry.captureException(error);
    });
  }

  return createErrorResponse({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: AUTH_MESSAGES.internalError,
  });
}
