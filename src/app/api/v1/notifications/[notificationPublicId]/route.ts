import { extractSearchParamsObject, handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getNotificationService } from '@/modules/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NotificationRouteContext {
  readonly params: Promise<{ readonly notificationPublicId: string }>;
}

export async function DELETE(request: Request, context: NotificationRouteContext) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { notificationPublicId } = await context.params;
    const query = extractSearchParamsObject(request);

    const result = await getNotificationService().deleteNotification(
      principal,
      notificationPublicId,
      query,
    );
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleSocialRouteError(error, 'DELETE /api/v1/notifications/:notificationPublicId');
  }
}
