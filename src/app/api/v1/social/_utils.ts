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
import { ProfileDomainError } from '@/modules/profile';
import { SOCIAL_MESSAGES, SocialDomainError } from '@/modules/social';

const MAX_SOCIAL_JSON_BODY_BYTES = 8 * 1024; // 8 KiB là quá đủ cho payload cài đặt riêng tư/tương tác.

export function extractSearchParamsObject(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const queryObject: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryObject[key] = value;
  }
  return queryObject;
}

export async function parseSocialJsonBody(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_SOCIAL_JSON_BODY_BYTES) {
      throw new SocialDomainError({
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
          if (totalBytes > MAX_SOCIAL_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new SocialDomainError({
              status: 413,
              code: 'VALIDATION_ERROR',
              message: AUTH_MESSAGES.payloadTooLarge,
            });
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof SocialDomainError) {
        throw error;
      }
      throw new SocialDomainError({
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
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    }

    if (Buffer.byteLength(rawText, 'utf8') > MAX_SOCIAL_JSON_BODY_BYTES) {
      throw new SocialDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  if (!rawText.trim()) {
    throw new SocialDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new SocialDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

export function handleSocialRouteError(
  error: unknown,
  endpoint: string,
): NextResponse<ApiErrorPayload> {
  if (error instanceof SocialDomainError) {
    return createErrorResponse({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }

  if (error instanceof ProfileDomainError) {
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
      message: SOCIAL_MESSAGES.validationFailed,
      details: formatZodErrorDetails(error),
    });
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown; readonly name?: unknown })
      : null;

  logger.error(
    {
      component: 'social-api',
      endpoint,
      errorCode:
        typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
          ? errObj.code
          : 'UNHANDLED_ERROR',
      errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
    },
    'Lỗi không mong đợi tại Social API endpoint',
  );

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('component', 'social-api');
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
