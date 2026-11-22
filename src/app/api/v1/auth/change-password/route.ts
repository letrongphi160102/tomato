import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
  setAuthCookies,
} from '@/core/security';
import { getAuthService, getSessionService } from '@/modules/auth';

// Bắt buộc dùng Node.js Runtime vì sử dụng @node-rs/argon2 (native binary), pg, ioredis và nodemailer.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Endpoint nhạy cảm đã đăng nhập: bắt buộc kiểm tra đủ 3 lớp CSRF (Sec-Fetch-Site + Origin + Double-Submit).
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const body = await parseAuthJsonBody(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    const result = await getAuthService().changePassword(principal, body, clientContext);

    const response = createAuthJsonResponse(
      {
        changed: result.changed,
        revokedOtherSessionsCount: result.revokedOtherSessionsCount,
        message: result.message,
      },
      { status: 200 },
    );

    // Xoay vòng đồng bộ cả AT, RT và CSRF cookie sang phiên mới vừa phát hành (chống session fixation);
    // tuyệt đối không trả token thô trong JSON body.
    setAuthCookies(response, result.tokens);
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/change-password');
  }
}
