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

export async function PUT(
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

    const result = await getChatService().upsertMessageReaction(principal, messagePublicId, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'PUT /api/v1/messages/[messagePublicId]/reaction');
  }
}

export async function DELETE(
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

    const result = await getChatService().removeMessageReaction(principal, messagePublicId);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'DELETE /api/v1/messages/[messagePublicId]/reaction');
  }
}
