import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  clearAuthCookies,
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
} from '@/core/security';
import { getAuthService } from '@/modules/auth';

// Bắt buộc dùng Node.js Runtime vì sử dụng @node-rs/argon2 (native binary), pg, ioredis và nodemailer.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Endpoint công khai xác thực bằng opaque reset token 256-bit -> kiểm tra lớp Origin + Sec-Fetch-Site.
  const csrfBlocked = enforceCsrfAndOrigin(request, { requireDoubleSubmit: false });
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const body = await parseAuthJsonBody(request);
    const clientContext = extractRequestClientContext(request);
    const result = await getAuthService().resetPassword(body, clientContext);

    const response = createAuthJsonResponse(result, { status: 200 });
    // Xóa sạch mọi cookie phiên cũ trên trình duyệt sau khi toàn bộ phiên DB đã bị thu hồi.
    clearAuthCookies(response, { clearCsrf: true });
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/reset-password');
  }
}
