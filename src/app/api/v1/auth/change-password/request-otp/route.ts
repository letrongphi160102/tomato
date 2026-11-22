import { handleAuthRouteError } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getAuthService, getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Endpoint đã đăng nhập: bắt buộc kiểm tra đủ 3 lớp CSRF (Sec-Fetch-Site + Origin + Double-Submit).
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const result = await getAuthService().requestPasswordChangeOtp(principal, clientContext);

    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/change-password/request-otp');
  }
}
