import { handleAuthRouteError } from '@/app/api/v1/auth/_utils';
import {
  REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
  setAuthCookies,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Yêu cầu đủ 3 lớp phòng thủ CSRF (Origin + Sec-Fetch-Site + Double-Submit X-CSRF-Token)
  // để ngăn website lạ ép xoay vòng hoặc phá hủy chuỗi Refresh Token của người dùng.
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const clientContext = extractRequestClientContext(request);
    const result = await getSessionService().refreshSession(cookies.refreshToken, clientContext);

    const response = createAuthJsonResponse(
      {
        refreshed: result.refreshed,
        user: result.user,
      },
      { status: 200 },
    );

    // Giữ Max-Age bền vững khớp đúng thời hạn tuyệt đối còn lại của phiên (tối đa 30 ngày)
    // để duy trì trạng thái đăng nhập xuyên suốt khi người dùng đóng và mở lại trình duyệt.
    const remainingSeconds = Math.max(
      60,
      Math.min(
        REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
        Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
      ),
    );

    setAuthCookies(
      response,
      {
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        csrfToken: cookies.csrfToken ?? undefined,
      },
      {
        refreshTokenMaxAgeSeconds: remainingSeconds,
        csrfTokenMaxAgeSeconds: remainingSeconds,
      },
    );

    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/refresh');
  }
}
