import { handleChatRouteError, parseChatJsonBody } from '@/app/api/v1/e2ee/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getChatService } from '@/modules/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const clientContext = extractRequestClientContext(request);

    const result = await getChatService().createAttachmentUploadToken(
      principal,
      conversationPublicId,
      body,
      clientContext,
    );
    return createAuthJsonResponse(result, { status: 201 });
  } catch (error) {
    return handleChatRouteError(
      error,
      'POST /api/v1/conversations/[conversationPublicId]/attachments/upload-token',
    );
  }
}
