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

interface RequesterRouteContext {
  readonly params: Promise<{ readonly userPublicId: string }>;
}

export async function POST(request: Request, context: RequesterRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { userPublicId } = await context.params;

    const result = await getSocialService().acceptFollowRequest(principal, userPublicId);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(
      error,
      'POST /api/v1/social/follow-requests/[userPublicId]/accept',
    );
  }
}
