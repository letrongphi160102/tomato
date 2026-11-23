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
import { CHAT_MESSAGES, ChatDomainError } from '@/modules/chat';
import { NotificationDomainError } from '@/modules/notifications/notification.errors';
import { SocialDomainError } from '@/modules/social';

// Giới hạn tối đa 64 KiB cho payload JSON chứa ciphertext + cryptoHeader (tối đa 20 wrappedKeys).
const MAX_CHAT_JSON_BODY_BYTES = 64 * 1024;

export async function parseChatJsonBody(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_CHAT_JSON_BODY_BYTES) {
      throw new ChatDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  let rawText: string;
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
          if (totalBytes > MAX_CHAT_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new ChatDomainError({
              status: 413,
              code: 'VALIDATION_ERROR',
              message: AUTH_MESSAGES.payloadTooLarge,
            });
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof ChatDomainError) {
        throw error;
      }
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    } finally {
      reader.releaseLock();
    }

    rawText = Buffer.concat(chunks, totalBytes).toString('utf8');
  } else {
    try {
      rawText = await request.text();
    } catch {
      throw new ChatDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    }

    if (Buffer.byteLength(rawText, 'utf8') > MAX_CHAT_JSON_BODY_BYTES) {
      throw new ChatDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  if (!rawText.trim()) {
    throw new ChatDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new ChatDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

export function handleChatRouteError(
  error: unknown,
  endpoint: string,
): NextResponse<ApiErrorPayload> {
  if (
    error instanceof ChatDomainError ||
    error instanceof SocialDomainError ||
    error instanceof NotificationDomainError
  ) {
    return createErrorResponse({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }

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
      message: CHAT_MESSAGES.validationFailed,
      details: formatZodErrorDetails(error),
    });
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown; readonly name?: unknown })
      : null;

  logger.error(
    {
      component: 'chat-api',
      endpoint,
      errorCode:
        typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
          ? errObj.code
          : 'UNHANDLED_ERROR',
      errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
    },
    'Lỗi không mong đợi tại Chat/E2EE API endpoint',
  );

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('component', 'chat-api');
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
