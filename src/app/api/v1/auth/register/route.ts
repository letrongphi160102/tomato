import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
} from '@/core/security';
import { getAuthService } from '@/modules/auth';

// Bắt buộc dùng Node.js Runtime vì sử dụng @node-rs/argon2 (native binary), pg, ioredis và nodemailer.
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
    const result = await getAuthService().register(body, clientContext);

    // Trả 202 Accepted khi tạo mới hoặc cấp lại OTP cho tài khoản `pending_verification`;
    // email đã thuộc tài khoản tồn tại (`active`/`locked`/`suspended`/`deleted`) ném 409 CONFLICT theo Mục 4.1.
    return createAuthJsonResponse(result, { status: 202 });
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/register');
  }
}
