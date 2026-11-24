import { NextResponse } from 'next/server';

import { handleChatRouteError } from '@/app/api/v1/e2ee/_utils';
import { extractSearchParamsObject } from '@/app/api/v1/social/_utils';
import {
  AUTH_CACHE_CONTROL_HEADER,
  createAuthJsonResponse,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import { getChatService } from '@/modules/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cổng tải xuống bản mã đính kèm chống BOLA:
 * - Mặc định trả JSON `{ attachmentPublicId, mediaKind, downloadUrl, ciphertextSha256, ciphertextSizeBytes }`.
 * - Khi `?download=1` (adapter Local/Memory): trả trực tiếp luồng byte `application/octet-stream` sau khi xác thực lại đủ ReBAC + RLS.
 */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly messagePublicId: string }> },
) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { messagePublicId } = await context.params;
    const query = extractSearchParamsObject(request);

    const result = await getChatService().getMessageAttachment(principal, messagePublicId, query);
    if (result.kind === 'binary') {
      return new NextResponse(new Uint8Array(result.body), {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Content-Length': String(result.body.byteLength),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': AUTH_CACHE_CONTROL_HEADER,
          Pragma: 'no-cache',
        },
      });
    }

    return createAuthJsonResponse(result.attachment, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'GET /api/v1/messages/[messagePublicId]/attachment');
  }
}
