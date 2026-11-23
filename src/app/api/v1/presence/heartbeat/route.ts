import { handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  createAuthJsonResponse,
  createErrorResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { AUTH_MESSAGES } from '@/modules/auth/auth.messages';
import { getPresenceService } from '@/modules/presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HEARTBEAT_BODY_BYTES = 1024;

async function parseOptionalEmptyJsonBody(request: Request): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_HEARTBEAT_BODY_BYTES) {
      throw new ResponseError(413, AUTH_MESSAGES.payloadTooLarge);
    }
  }

  let rawText = '';
  try {
    rawText = await request.text();
  } catch {
    throw new ResponseError(400, AUTH_MESSAGES.invalidJsonBody);
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_HEARTBEAT_BODY_BYTES) {
    throw new ResponseError(413, AUTH_MESSAGES.payloadTooLarge);
  }

  if (!rawText.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new ResponseError(400, AUTH_MESSAGES.invalidJsonBody);
  }
}

class ResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
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
    const body = await parseOptionalEmptyJsonBody(request);

    const result = await getPresenceService().recordHeartbeat(principal, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    if (error instanceof ResponseError) {
      return createErrorResponse({
        status: error.status,
        code: 'VALIDATION_ERROR',
        message: error.message,
      });
    }
    return handleSocialRouteError(error, 'POST /api/v1/presence/heartbeat');
  }
}
