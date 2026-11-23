import { handleProfileRouteError } from '@/app/api/v1/users/_utils';
import { createAuthJsonResponse, getAuthCookiesFromRequest } from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getProfileService } from '@/modules/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserHandleRouteContext {
  readonly params: Promise<{ readonly handle: string }>;
}

export async function GET(request: Request, context: UserHandleRouteContext) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { handle } = await context.params;

    const result = await getProfileService().getProfileByHandle(principal, handle);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'GET /api/v1/users/[handle]');
  }
}
