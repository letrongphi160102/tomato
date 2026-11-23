import { handleChatRouteError } from '@/app/api/v1/e2ee/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
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

    const result = await getChatService().getConversationByPublicId(
      principal,
      conversationPublicId,
    );
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'GET /api/v1/conversations/[conversationPublicId]');
  }
}
