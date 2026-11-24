import { handleCallRouteError, parseCallJsonBody } from '@/app/api/v1/calls/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getCallSignalingService } from '@/modules/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const clientContext = extractRequestClientContext(request);
    const body = await parseCallJsonBody(request, { allowEmpty: true });
    const result = await getCallSignalingService().getIceServers(principal, clientContext, body);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleCallRouteError(error, 'POST /api/v1/calls/ice-servers');
  }
}
