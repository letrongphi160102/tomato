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
import { CALL_MESSAGES, CallDomainError } from '@/modules/calls';

// Cho phép JSON body tối đa 48 KiB để chứa SDP 32 KB (đa codec Chrome/Safari mới) + khung JSON.
const MAX_CALL_JSON_BODY_BYTES = 48 * 1024;

export async function parseCallJsonBody(
  request: Request,
  options: { readonly allowEmpty?: boolean } = {},
): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_CALL_JSON_BODY_BYTES) {
      throw new CallDomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
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
          if (totalBytes > MAX_CALL_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new CallDomainError({
              status: 413,
              code: 'PAYLOAD_TOO_LARGE',
              message: AUTH_MESSAGES.payloadTooLarge,
            });
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof CallDomainError) {
        throw error;
      }
      throw new CallDomainError({
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
      throw new CallDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    }

    if (Buffer.byteLength(rawText, 'utf8') > MAX_CALL_JSON_BODY_BYTES) {
      throw new CallDomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  if (!rawText.trim()) {
    if (options.allowEmpty) {
      return {};
    }
    throw new CallDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new CallDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

export function handleCallRouteError(
  error: unknown,
  endpoint: string,
): NextResponse<ApiErrorPayload> {
  if (error instanceof CallDomainError) {
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
      message: CALL_MESSAGES.validationFailed,
      details: formatZodErrorDetails(error),
    });
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown; readonly name?: unknown })
      : null;

  logger.error(
    {
      component: 'calls-api',
      endpoint,
      errorCode:
        typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
          ? errObj.code
          : 'UNHANDLED_ERROR',
      errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
    },
    'Lỗi không mong đợi tại Calls API endpoint',
  );

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('component', 'calls-api');
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
