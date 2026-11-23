import { z } from 'zod';

import { extractSearchParamsObject, handleSocialRouteError } from '@/app/api/v1/social/_utils';
import {
  authorizeRealtimeAction,
  buildUserRealtimeChannel,
  getRealtimeProvider,
  getRealtimeRateLimiter,
} from '@/core/realtime';
import { REALTIME_RATE_LIMITS } from '@/core/redis';
import {
  AUTH_CACHE_CONTROL_HEADER,
  createErrorResponse,
  formatZodErrorDetails,
  getAuthCookiesFromRequest,
} from '@/core/security';
import { getSessionService } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
const emptyQueryStrictSchema = z.object({}).strict();

function encodeSseFrame(eventName: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  try {
    const cookies = getAuthCookiesFromRequest(request);
    const principal = await getSessionService().authenticateAccessToken(cookies.accessToken);

    if (!authorizeRealtimeAction(principal, 'realtime:subscribe')) {
      return createErrorResponse({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Không tìm thấy tài nguyên được yêu cầu.',
      });
    }

    const queryObject = extractSearchParamsObject(request);
    const parsedQuery = emptyQueryStrictSchema.safeParse(queryObject);
    if (!parsedQuery.success) {
      return createErrorResponse({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Tham số yêu cầu không hợp lệ.',
        details: formatZodErrorDetails(parsedQuery.error),
      });
    }

    const provider = getRealtimeProvider();
    if (provider.provider !== 'local' || typeof provider.subscribeLocal !== 'function') {
      return createErrorResponse({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Không tìm thấy tài nguyên được yêu cầu.',
      });
    }

    const rateLimit = await getRealtimeRateLimiter().consume(
      `realtime:stream:user:${principal.user.id}`,
      REALTIME_RATE_LIMITS.openStreamByUser,
    );
    if (!rateLimit.allowed) {
      return createErrorResponse({
        status: 429,
        code: 'RATE_LIMITED',
        message: `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${rateLimit.retryAfterSeconds} giây.`,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    const actorPublicId = principal.user.publicId;
    const channel = buildUserRealtimeChannel(actorPublicId);
    const pingFrame = new TextEncoder().encode(': ping\n\n');

    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(chunk);
          } catch {
            doCleanup();
          }
        };

        const unsubscribe = provider.subscribeLocal!(actorPublicId, (message) => {
          safeEnqueue(encodeSseFrame(message.event, message.data));
        });

        const heartbeatTimer = setInterval(() => {
          safeEnqueue(pingFrame);
        }, SSE_HEARTBEAT_INTERVAL_MS);

        const handleAbort = () => {
          doCleanup();
        };

        const doCleanup = () => {
          if (closed) {
            return;
          }
          closed = true;
          clearInterval(heartbeatTimer);
          unsubscribe();
          request.signal.removeEventListener('abort', handleAbort);
          try {
            controller.close();
          } catch {
            // Stream có thể đã được đóng bởi runtime.
          }
        };

        cleanup = doCleanup;
        request.signal.addEventListener('abort', handleAbort, { once: true });

        if (request.signal.aborted) {
          doCleanup();
          return;
        }

        safeEnqueue(encodeSseFrame('connected', { channel }));
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': `${AUTH_CACHE_CONTROL_HEADER}, no-transform`,
        Pragma: 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return handleSocialRouteError(error, 'GET /api/v1/realtime/stream');
  }
}
