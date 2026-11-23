import { extractSearchParamsObject, handleSocialRouteError } from '@/app/api/v1/social/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getSocialService } from '@/modules/social';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserConnectionsRouteContext {
  readonly params: Promise<{ readonly userPublicId: string }>;
}

export async function GET(request: Request, context: UserConnectionsRouteContext) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { userPublicId } = await context.params;
    const query = extractSearchParamsObject(request);

    const result = await getSocialService().listFollowers(principal, userPublicId, query);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'GET /api/v1/social/users/[userPublicId]/followers');
  }
}
