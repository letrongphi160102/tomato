import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  clearPasswordChangeTicketCookie,
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
  getPasswordChangeTicketFromRequest,
  setAuthCookies,
} from '@/core/security';
import { getAuthService, getSessionService } from '@/modules/auth';

// Bắt buộc dùng Node.js Runtime vì sử dụng @node-rs/argon2 (native binary), pg, ioredis và nodemailer.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Bước 2 đổi mật khẩu (đã đăng nhập): bắt buộc kiểm tra đủ 3 lớp CSRF (Sec-Fetch-Site + Origin + Double-Submit).
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const rawTicket = getPasswordChangeTicketFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const body = await parseAuthJsonBody(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    const result = await getAuthService().changePassword(principal, body, rawTicket, clientContext);

    const response = createAuthJsonResponse(
      {
        changed: result.changed,
        revokedOtherSessionsCount: result.revokedOtherSessionsCount,
        message: result.message,
      },
      { status: 200 },
    );

    // Xoay vòng đồng bộ cả AT, RT và CSRF cookie sang phiên mới vừa phát hành (chống session fixation),
    // đồng thời xóa sạch cookie ticket Bước 1 ngay khi đổi mật khẩu thành công.
    setAuthCookies(response, result.tokens);
    clearPasswordChangeTicketCookie(response);
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/change-password');
  }
}
