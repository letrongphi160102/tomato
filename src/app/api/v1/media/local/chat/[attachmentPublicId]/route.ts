import { handleChatRouteError } from '@/app/api/v1/e2ee/_utils';
import {
  createAuthJsonResponse,
  enforceCsrfAndOrigin,
  extractRequestClientContext,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';
import {
  CHAT_MESSAGES,
  ChatDomainError,
  MAX_IMAGE_CIPHERTEXT_BYTES,
  getChatService,
} from '@/modules/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readBoundedBinaryBody(request: Request, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new ChatDomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: CHAT_MESSAGES.attachmentTooLargeImage,
      });
    }
  }

  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new ChatDomainError({
              status: 413,
              code: 'PAYLOAD_TOO_LARGE',
              message: CHAT_MESSAGES.attachmentTooLargeImage,
            });
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
  }

  const arrayBuffer = await request.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new ChatDomainError({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: CHAT_MESSAGES.attachmentTooLargeImage,
    });
  }
  return Buffer.from(arrayBuffer);
}

/**
 * Cổng upload nhị phân cục bộ cho môi trường Local Dev & CI (chỉ hoạt động khi storage !== vercel_blob).
 * Bắt buộc Access Token + CSRF 3 lớp + kiểm tra khớp tuyệt đối dung lượng & SHA-256 bản mã.
 */
export async function PUT(
  request: Request,
  context: { readonly params: Promise<{ readonly attachmentPublicId: string }> },
) {
  const csrfBlocked = enforceCsrfAndOrigin(request);
  if (csrfBlocked) {
    return csrfBlocked;
  }

  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);
    const { attachmentPublicId } = await context.params;
    const clientContext = extractRequestClientContext(request);
    const body = await readBoundedBinaryBody(request, MAX_IMAGE_CIPHERTEXT_BYTES);

    const result = await getChatService().uploadLocalEncryptedAttachment(
      principal,
      attachmentPublicId,
      body,
      request.headers.get('content-type'),
      clientContext,
    );
    return createAuthJsonResponse(result, { status: 200 });
  } catch (error) {
    return handleChatRouteError(error, 'PUT /api/v1/media/local/chat/[attachmentPublicId]');
  }
}
