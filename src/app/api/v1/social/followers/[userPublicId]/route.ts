import { handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSocialService } from '@/modules/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface FollowerRouteContext {
  readonly params: Promise<{ readonly userPublicId: string }>;
}

export async function DELETE(request: Request, context: FollowerRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { userPublicId } = await context.params;

    const result = await getSocialService().removeFollower(principal, userPublicId);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'DELETE /api/v1/social/followers/[userPublicId]');
  }
}
