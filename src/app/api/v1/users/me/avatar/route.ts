import { handleProfileRouteError, parseAvatarUploadBuffer } from '@/app/api/v1/users/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getProfileService } from '@/modules/profile';

// Bắt buộc dùng Node.js Runtime vì xử lý ảnh bằng `sharp` (native libvips) và `file-type`.
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
    const fileBuffer = await parseAvatarUploadBuffer(request);
    const clientContext = extractRequestClientContext(request);

    const result = await getProfileService().uploadOwnAvatar(principal, fileBuffer, clientContext);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'POST /api/v1/users/me/avatar');
  }
}

export async function DELETE(request: Request) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const clientContext = extractRequestClientContext(request);

    const result = await getProfileService().deleteOwnAvatar(principal, clientContext);
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleProfileRouteError(error, 'DELETE /api/v1/users/me/avatar');
  }
}
