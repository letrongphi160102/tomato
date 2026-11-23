import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { logger } from '@/core/logger';
import { AVATAR_MAX_UPLOAD_BYTES } from '@/core/media';
import { clearAuthCookies } from '@/core/security/cookies';
import {
  createErrorResponse,
  formatZodErrorDetails,
  type ApiErrorPayload,
} from '@/core/security/http-response';
import { AuthDomainError } from '@/modules/auth/auth.errors';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { PROFILE_MESSAGES, ProfileDomainError } from '@/modules/profile';

const MAX_PROFILE_JSON_BODY_BYTES = 16 * 1024; // 16 KiB đủ cho biểu mẫu cập nhật hồ sơ.
// Cho phép overhead nhỏ của multipart boundary (~256 KiB) bên trên giới hạn ảnh 10 MB.
const MAX_AVATAR_MULTIPART_BYTES = AVATAR_MAX_UPLOAD_BYTES + 256 * 1024;

export async function parseProfileJsonBody(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PROFILE_JSON_BODY_BYTES) {
      throw new ProfileDomainError({
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
          if (totalBytes > MAX_PROFILE_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new ProfileDomainError({
              status: 413,
              code: 'VALIDATION_ERROR',
              message: AUTH_MESSAGES.payloadTooLarge,
            });
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof ProfileDomainError) {
        throw error;
      }
      throw new ProfileDomainError({
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
      throw new ProfileDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.invalidJsonBody,
      });
    }

    if (Buffer.byteLength(rawText, 'utf8') > MAX_PROFILE_JSON_BODY_BYTES) {
      throw new ProfileDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  if (!rawText.trim()) {
    throw new ProfileDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new ProfileDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }
}

export async function parseAvatarUploadBuffer(request: Request): Promise<Buffer> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_AVATAR_MULTIPART_BYTES) {
      throw new ProfileDomainError({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: PROFILE_MESSAGES.invalidAvatar,
        details: [{ field: 'file', message: PROFILE_MESSAGES.invalidAvatar }],
      });
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ProfileDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: PROFILE_MESSAGES.invalidAvatar,
      details: [{ field: 'file', message: PROFILE_MESSAGES.invalidAvatar }],
    });
  }

  const fileEntry = formData.get('file');
  if (!(fileEntry instanceof Blob)) {
    throw new ProfileDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: PROFILE_MESSAGES.avatarFileRequired,
      details: [{ field: 'file', message: PROFILE_MESSAGES.avatarFileRequired }],
    });
  }

  if (fileEntry.size === 0) {
    throw new ProfileDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: PROFILE_MESSAGES.invalidAvatar,
      details: [{ field: 'file', message: PROFILE_MESSAGES.invalidAvatar }],
    });
  }

  if (fileEntry.size > AVATAR_MAX_UPLOAD_BYTES) {
    throw new ProfileDomainError({
      status: 413,
      code: 'VALIDATION_ERROR',
      message: PROFILE_MESSAGES.invalidAvatar,
      details: [{ field: 'file', message: PROFILE_MESSAGES.invalidAvatar }],
    });
  }

  const arrayBuffer = await fileEntry.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function handleProfileRouteError(
  error: unknown,
  endpoint: string,
): NextResponse<ApiErrorPayload> {
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
      message: PROFILE_MESSAGES.validationFailed,
      details: formatZodErrorDetails(error),
    });
  }

  const errObj =
    typeof error === 'object' && error !== null
      ? (error as { readonly code?: unknown; readonly name?: unknown })
      : null;

  logger.error(
    {
      component: 'profile-api',
      endpoint,
      errorCode:
        typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
          ? errObj.code
          : 'UNHANDLED_ERROR',
      errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
    },
    'Lỗi không mong đợi tại Profile API endpoint',
  );

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag('component', 'profile-api');
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
