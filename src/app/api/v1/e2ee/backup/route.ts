import { handleChatRouteError, parseChatJsonBody } from '@/app/api/v1/e2ee/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getChatService } from '@/modules/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    const result = await getChatService().getKeyBackup(principal);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'GET /api/v1/e2ee/backup');
  }
}

export async function PUT(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const body = await parseChatJsonBody(request);

    const result = await getChatService().upsertKeyBackup(principal, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'PUT /api/v1/e2ee/backup');
  }
}
