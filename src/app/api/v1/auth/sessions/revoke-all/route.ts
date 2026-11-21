import { handleAuthRouteError, parseOptionalAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  clearAuthCookies,
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const body = await parseOptionalAuthJsonBody(request);
    const sessionService = getSessionService();
    const principal = await sessionService.authenticateAccessToken(cookies.accessToken);

    const result = await sessionService.revokeAllSessions(principal, body, clientContext);

    const response = createAuthJsonResponse(result, { status: 200 });
    if (result.includeCurrent) {
      clearAuthCookies(response, { clearCsrf: true });
    }

    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/sessions/revoke-all');
  }
}
