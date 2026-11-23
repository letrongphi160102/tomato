import '@/core/validation/zod-config';
import { z } from 'zod';

import { handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  authorizeRealtimeAction,
  getRealtimeProvider,
  getRealtimeRateLimiter,
} from '@/core/realtime';
import { REALTIME_RATE_LIMITS } from '@/core/redis';
import {
  createAuthJsonResponse,
  createErrorResponse,
  enforceCsrfAndOrigin,
  formatZodErrorDetails,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOKEN_BODY_BYTES = 1024;
const emptyObjectStrictSchema = z.object({}).strict();

async function validateEmptyStrictBody(request: Request): Promise<Response | null> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TOKEN_BODY_BYTES) {
      return createErrorResponse({
        status: 413,
        code: 'VALIDATION_ERROR',
        message: AUTH_MESSAGES.payloadTooLarge,
      });
    }
  }

  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    return createErrorResponse({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_TOKEN_BODY_BYTES) {
    return createErrorResponse({
      status: 413,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.payloadTooLarge,
    });
  }

  if (!rawText.trim()) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText) as unknown;
  } catch {
    return createErrorResponse({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  const parsed = emptyObjectStrictSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Yêu cầu cấp phiên kết nối không chấp nhận tham số bổ sung.',
      details: formatZodErrorDetails(parsed.error),
    });
  }

  return null;
}

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    if (!authorizeRealtimeAction(principal, 'realtime:token')) {
      return createErrorResponse({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Không tìm thấy tài nguyên được yêu cầu.',
      });
    }

    const rateLimit = await getRealtimeRateLimiter().consume(
      `realtime:token:user:${principal.user.id}`,
      REALTIME_RATE_LIMITS.issueTokenByUser,
    );
    if (!rateLimit.allowed) {
      return createErrorResponse({
        status: 429,
        code: 'RATE_LIMITED',
        message: `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${rateLimit.retryAfterSeconds} giây.`,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    const invalidBodyResponse = await validateEmptyStrictBody(request);
    if (invalidBodyResponse) {
      return invalidBodyResponse;
    }

    // Luôn lấy publicId từ Access Token đã xác minh; tuyệt đối không nhận channel/userId từ client.
    const tokenPayload = await getRealtimeProvider().createSubscribeToken(principal.user.publicId);
    return createAuthJsonResponse(tokenPayload, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'POST /api/v1/realtime/token');
  }
}
