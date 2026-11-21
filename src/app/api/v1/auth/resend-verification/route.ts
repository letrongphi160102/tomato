import { handleAuthRouteError, parseAuthJsonBody } from '@/app/api/v1/auth/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
} from '@/core/security';
import { getAuthService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request, { requireDoubleSubmit: false });
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const body = await parseAuthJsonBody(request);
    const clientContext = extractRequestClientContext(request);
    const result = await getAuthService().resendVerification(body, clientContext);

    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleAuthRouteError(error, 'POST /api/v1/auth/resend-verification');
  }
}
