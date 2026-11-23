import { handleSocialRouteError, parseSocialJsonBody } from '@/app/api/v1/social/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getPresenceService } from '@/modules/presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const body = await parseSocialJsonBody(request);

    const result = await getPresenceService().queryPresences(principal, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'POST /api/v1/presence/query');
  }
}
