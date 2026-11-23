import { handleProfileRouteError } from '@/app/api/v1/users/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getProfileService } from '@/modules/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    const url = new URL(request.url);
    const queryObject: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      queryObject[key] = value;
    }

    const result = await getProfileService().searchUsers(principal, queryObject);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'GET /api/v1/users/search');
  }
}
