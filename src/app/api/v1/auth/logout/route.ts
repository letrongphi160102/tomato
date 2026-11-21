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

export async function POST(request: Request) {
  // Chống Logout CSRF bằng đủ 3 lớp: Origin + Sec-Fetch-Site + Double-Submit X-CSRF-Token.
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const result = await getSessionService().logoutCurrentSession(
      {
        accessToken: cookies.accessToken,
        refreshToken: cookies.refreshToken,
      },
      clientContext,
    );

    const response = createAuthJsonResponse(result, { status: 200 });
    clearAuthCookies(response, { clearCsrf: true });
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/logout');
  }
}
