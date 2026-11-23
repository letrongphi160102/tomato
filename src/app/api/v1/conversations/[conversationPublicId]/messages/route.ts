import { handleChatRouteError, parseChatJsonBody } from '@/app/api/v1/e2ee/_utils';
import { extractSearchParamsObject } from '@/app/api/v1/social/_utils';
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
  context: { readonly params: Promise<{ readonly conversationPublicId: string }> },
) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { conversationPublicId } = await context.params;
    const query = extractSearchParamsObject(request);

    const result = await getChatService().listMessages(principal, conversationPublicId, query);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'GET /api/v1/conversations/[conversationPublicId]/messages');
  }
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly conversationPublicId: string }> },
) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { conversationPublicId } = await context.params;
    const body = await parseChatJsonBody(request);

    const result = await getChatService().sendMessage(principal, conversationPublicId, body);
    return createAuthJsonResponse(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return handleChatRouteError(
      error,
      'POST /api/v1/conversations/[conversationPublicId]/messages',
    );
  }
}
