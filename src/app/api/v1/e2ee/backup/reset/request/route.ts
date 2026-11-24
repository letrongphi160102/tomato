import { handleChatRouteError } from '@/app/api/v1/e2ee/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { ChatDomainError, getChatService } from '@/modules/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RESET_REQUEST_BODY_BYTES = 4 * 1024;

async function parseOptionalStrictEmptyBody(request: Request): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    throw new ChatDomainError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.invalidJsonBody,
    });
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_RESET_REQUEST_BODY_BYTES) {
    throw new ChatDomainError({
      status: 413,
      code: 'VALIDATION_ERROR',
      message: AUTH_MESSAGES.payloadTooLarge,
    });
  }

  if (!rawText.trim()) {
    return {};
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

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const body = await parseOptionalStrictEmptyBody(request);
    const context = extractRequestClientContext(request);

    const result = await getChatService().requestPinResetOtp(principal, body, context);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'POST /api/v1/e2ee/backup/reset/request');
  }
}
