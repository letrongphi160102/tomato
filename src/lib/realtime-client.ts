import type { InboundMessage, RealtimeClient, TokenRequest } from 'ably';

import { authFetch } from '@/lib/auth-client';
import type { RealtimeEventName, RealtimeSubscribeTokenDto } from '@/core/realtime/types';

export interface RealtimeClientEvent {
  readonly event: RealtimeEventName;
  readonly data: Record<string, unknown>;
}

export interface RealtimeClientConnection {
  disconnect: () => void;
}

const SUPPORTED_EVENT_NAMES: ReadonlySet<string> = new Set<RealtimeEventName>([
  'notification.created',
  'notification.read',
  'notification.removed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestRealtimeToken(): Promise<RealtimeSubscribeTokenDto | null> {
  try {
    const response = await authFetch('/api/v1/realtime/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as Partial<RealtimeSubscribeTokenDto>;
    if (
      (payload.provider !== 'ably' && payload.provider !== 'local') ||
      typeof payload.channel !== 'string' ||
      !payload.channel.startsWith('user:')
    ) {
      return null;
    }
    return payload as RealtimeSubscribeTokenDto;
  } catch {
    return null;
  }
}

const activeConnections = new Set<() => void>();

/**
 * Đóng ngay lập tức toàn bộ kết nối Realtime đang mở (Ably WSS / SSE) khi người dùng đăng xuất.
 */
export function disconnectAllRealtimeConnections(): void {
  for (const disconnect of Array.from(activeConnections)) {
    try {
      disconnect();
    } catch {
      // Bỏ qua lỗi khi đóng kết nối trong quá trình đăng xuất.
    }
  }
  activeConnections.clear();
}

export interface ConnectRealtimeOptions {
  readonly onEvent: (event: RealtimeClientEvent) => void;
}

/**
 * Thiết lập kết nối Realtime chỉ-nghe (subscribe-only) tới kênh cá nhân `user:{publicId}`:
 * - Production / có `ABLY_API_KEY`: dùng Ably WSS + `authCallback` tự gia hạn mỗi 15 phút qua `/api/v1/realtime/token`.
 * - Local fallback: dùng `EventSource('/api/v1/realtime/stream')` qua SSE.
 */
export function connectUserRealtime(options: ConnectRealtimeOptions): RealtimeClientConnection {
  let disposed = false;
  let ablyClient: RealtimeClient | null = null;
  let eventSource: EventSource | null = null;
  let channelUnsubscribe: (() => void) | null = null;

  const disconnect = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    activeConnections.delete(disconnect);

    if (channelUnsubscribe) {
      try {
        channelUnsubscribe();
      } catch {
        // Không ném lỗi khi hủy đăng ký kênh.
      }
      channelUnsubscribe = null;
    }

    if (ablyClient) {
      try {
        ablyClient.close();
      } catch {
        // Không ném lỗi khi đóng Ably client.
      }
      ablyClient = null;
    }

    if (eventSource) {
      try {
        eventSource.close();
      } catch {
        // Không ném lỗi khi đóng EventSource.
      }
      eventSource = null;
    }
  };

  activeConnections.add(disconnect);

  void (async () => {
    const initialToken = await requestRealtimeToken();
    if (disposed || !initialToken) {
      return;
    }

    if (initialToken.provider === 'local' && initialToken.streamUrl) {
      if (typeof EventSource === 'undefined') {
        return;
      }

      const source = new EventSource(initialToken.streamUrl, { withCredentials: true });
      eventSource = source;

      const eventNames: readonly RealtimeEventName[] = [
        'notification.created',
        'notification.read',
        'notification.removed',
      ];

      for (const eventName of eventNames) {
        source.addEventListener(eventName, (rawEvent) => {
          if (disposed) {
            return;
          }
          const messageEvent = rawEvent as MessageEvent<string>;
          try {
            const parsed: unknown = JSON.parse(messageEvent.data);
            if (isRecord(parsed)) {
              options.onEvent({ event: eventName, data: parsed });
            }
          } catch {
            // Bỏ qua frame không hợp lệ.
          }
        });
      }
      return;
    }

    if (initialToken.provider === 'ably' && initialToken.tokenRequest) {
      const { Realtime: RealtimeCtor } = await import('ably');
      if (disposed || !RealtimeCtor) {
        return;
      }

      let cachedInitialTokenRequest: TokenRequest | null =
        initialToken.tokenRequest as TokenRequest;

      const client = new RealtimeCtor({
        autoConnect: true,
        authCallback: (_tokenParams, callback) => {
          if (disposed) {
            callback('Kết nối đã đóng.', null);
            return;
          }
          if (cachedInitialTokenRequest) {
            const firstToken = cachedInitialTokenRequest;
            cachedInitialTokenRequest = null;
            callback(null, firstToken);
            return;
          }
          void requestRealtimeToken().then((fresh) => {
            if (disposed || !fresh?.tokenRequest) {
              callback('Không thể gia hạn kết nối.', null);
              return;
            }
            callback(null, fresh.tokenRequest as TokenRequest);
          });
        },
      });

      if (disposed) {
        client.close();
        return;
      }

      ablyClient = client;
      const channel = client.channels.get(initialToken.channel);

      const handleInbound = (message: InboundMessage) => {
        if (disposed || !message.name || !SUPPORTED_EVENT_NAMES.has(message.name)) {
          return;
        }
        if (isRecord(message.data)) {
          options.onEvent({
            event: message.name as RealtimeEventName,
            data: message.data,
          });
        }
      };

      void channel.subscribe(handleInbound);
      channelUnsubscribe = () => {
        channel.unsubscribe(handleInbound);
      };
    }
  })();

  return { disconnect };
}
