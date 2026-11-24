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

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly messagePublicId: string }> },
) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { messagePublicId } = await context.params;

    const result = await getChatService().getMessageByPublicId(principal, messagePublicId);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'GET /api/v1/messages/[messagePublicId]');
  }
}

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly messagePublicId: string }> },
) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { messagePublicId } = await context.params;
    const body = await parseChatJsonBody(request);

    const result = await getChatService().editMessage(principal, messagePublicId, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'PATCH /api/v1/messages/[messagePublicId]');
  }
}
