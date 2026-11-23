import { handleProfileRouteError, parseProfileJsonBody } from '@/app/api/v1/users/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getProfileService } from '@/modules/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const result = await getProfileService().getOwnProfile(principal);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'GET /api/v1/users/me/profile');
  }
}

export async function PATCH(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const body = await parseProfileJsonBody(request);
    const clientContext = extractRequestClientContext(request);

    const result = await getProfileService().updateOwnProfile(principal, body, clientContext);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'PATCH /api/v1/users/me/profile');
  }
}
