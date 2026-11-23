import { extractSearchParamsObject, handleSocialRouteError } from '@/app/api/v1/social/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getNotificationService } from '@/modules/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const query = extractSearchParamsObject(request);

    const result = await getNotificationService().listNotifications(principal, query);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'GET /api/v1/notifications');
  }
}
