import { handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSocialService } from '@/modules/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BlockTargetRouteContext {
  readonly params: Promise<{ readonly userPublicId: string }>;
}

export async function POST(request: Request, context: BlockTargetRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { userPublicId } = await context.params;
    const clientContext = extractRequestClientContext(request);

    const result = await getSocialService().blockUser(principal, userPublicId, clientContext);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'POST /api/v1/social/blocks/[userPublicId]');
  }
}

export async function DELETE(request: Request, context: BlockTargetRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { userPublicId } = await context.params;
    const clientContext = extractRequestClientContext(request);

    const result = await getSocialService().unblockUser(principal, userPublicId, clientContext);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'DELETE /api/v1/social/blocks/[userPublicId]');
  }
}
