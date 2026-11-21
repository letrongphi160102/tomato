import { handleAuthRouteError } from '@/app/api/v1/auth/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const sessionService = getSessionService();
    const principal = await sessionService.authenticateAccessToken(cookies.accessToken);
    const result = await sessionService.listActiveSessions(principal);

    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleAuthRouteError(error, 'GET /api/v1/auth/sessions');
  }
}
