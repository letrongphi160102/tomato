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

export async function POST(
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

    const rawText = await request.text();
    let body: unknown = {};
    if (rawText.trim().length > 0) {
      const cloned = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: rawText,
      });
      body = await parseChatJsonBody(cloned);
    }

    const result = await getChatService().recallMessage(principal, messagePublicId, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'POST /api/v1/messages/[messagePublicId]/recall');
  }
}
