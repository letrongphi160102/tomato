import { handleAuthRouteError } from '@/app/api/v1/auth/_utils';
import {
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

    // Giữ nguyên giá trị CSRF cookie hợp lệ hiện tại để tránh phá vỡ các tab đang mở cùng phiên,
    // đồng thời gia hạn cùng chu kỳ với Refresh Token mới.
    setAuthCookies(response, {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      csrfToken: cookies.csrfToken ?? undefined,
    });

    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/refresh');
  }
}
