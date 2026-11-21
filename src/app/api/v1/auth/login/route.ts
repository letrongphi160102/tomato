import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  setAuthCookies,
} from '@/core/security';
import { getAuthService } from '@/modules/auth';

// Bắt buộc dùng Node.js Runtime vì sử dụng @node-rs/argon2 (native binary), pg và ioredis.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Endpoint công khai chưa có cookie phiên nên kiểm tra lớp Origin + Sec-Fetch-Site.
  const csrfBlocked = enforceCsrfAndOrigin(request, { requireDoubleSubmit: false });
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const body = await parseAuthJsonBody(request);
    const clientContext = extractRequestClientContext(request);
    const result = await getAuthService().login(body, clientContext);

    const response = createAuthJsonResponse(
      {
        user: result.user,
        message: result.message,
      },
      { status: 200 },
    );

    // Gắn bộ 3 cookie thông minh (AT + RT HttpOnly và CSRF cookie Double-Submit);
    // tuyệt đối không trả token thô trong JSON body ở chế độ Web Client.
    setAuthCookies(response, result.tokens);
    return response;
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/login');
  }
}
