import { handleAuthRouteError } from '@/app/api/v1/auth/_utils';
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

interface SessionRouteContext {
  readonly params: Promise<{ readonly sessionPublicId: string }>;
}

export async function DELETE(request: Request, routeContext: SessionRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const sessionService = getSessionService();
    const principal = await sessionService.authenticateAccessToken(cookies.accessToken);
    const { sessionPublicId } = await routeContext.params;

    const result = await sessionService.revokeSession(principal, sessionPublicId, clientContext);

    const response = createAuthJsonResponse(
      {
        revoked: result.revoked,
        sessionPublicId: result.sessionPublicId,
        message: result.message,
      },
      { status: 200 },
    );

    if (result.revokedCurrent) {
      clearAuthCookies(response, { clearCsrf: true });
    }

    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'DELETE /api/v1/auth/sessions/:sessionPublicId');
  }
}
