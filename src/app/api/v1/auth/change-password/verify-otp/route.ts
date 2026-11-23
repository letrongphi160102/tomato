import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
  setPasswordChangeTicketCookie,
} from '@/core/security';
import { getAuthService, getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Bước 1b đổi mật khẩu (đã đăng nhập): bắt buộc đủ 3 lớp CSRF (Origin + Sec-Fetch-Site + Double-Submit).
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const body = await parseAuthJsonBody(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const result = await getAuthService().verifyPasswordChangeOtp(principal, body, clientContext);

    const response = createAuthJsonResponse(
      {
        verified: result.verified,
        expiresInMinutes: result.expiresInMinutes,
        message: result.message,
      },
      { status: 200 },
    );

    // Gửi ticket dùng một lần sống ngắn (10 phút) qua HttpOnly cookie để chống XSS đánh cắp ticket.
    setPasswordChangeTicketCookie(response, result.ticket);
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/change-password/verify-otp');
  }
}
