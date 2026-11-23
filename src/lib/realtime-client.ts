import type { InboundMessage, PubSubClient, TokenRequest } from '@ably/pubsub-device';

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
  'notification.deleted',
  'chat.message.created',
  'chat.conversation.read',
  'chat.conversation.updated',
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
 * Thời gian ân hạn giữ kết nối Realtime sống khi chuyển trang nội bộ (`/` <-> `/messages`)
 * để không làm rớt sự kiện Ably/SSE phát sinh trong khoảnh khắc chuyển route.
 */
export const REALTIME_MULTIPLEX_GRACE_MS = 1500;

interface SharedRealtimeMultiplexer {
  readonly userPublicId: string;
  readonly subscribers: Set<(event: RealtimeClientEvent) => void>;
  graceCloseTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  closePhysicalConnection: () => void;
}

let activeSharedMultiplexer: SharedRealtimeMultiplexer | null = null;

function destroySharedMultiplexerImmediate(mux: SharedRealtimeMultiplexer | null): void {
  if (!mux) {
    return;
  }
  if (mux.graceCloseTimer !== null) {
    clearTimeout(mux.graceCloseTimer);
    mux.graceCloseTimer = null;
  }
  mux.subscribers.clear();
  mux.closePhysicalConnection();
  if (activeSharedMultiplexer === mux) {
    activeSharedMultiplexer = null;
  }
}

/**
 * Đóng ngay lập tức toàn bộ kết nối Realtime đang mở (Ably WSS / SSE) khi người dùng đăng xuất
 * hoặc chuyển đổi tài khoản (bỏ qua hoàn toàn grace timeout 1500ms).
 */
export function disconnectAllRealtimeConnections(): void {
  destroySharedMultiplexerImmediate(activeSharedMultiplexer);
  activeSharedMultiplexer = null;

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
  readonly userPublicId?: string;
  readonly onEvent: (event: RealtimeClientEvent) => void;
  /** Tuỳ chọn nạp hàm lấy token cho kiểm thử đơn vị (Unit Test). */
  readonly requestTokenFn?: () => Promise<RealtimeSubscribeTokenDto | null>;
}

function openPhysicalRealtimeConnection(
  dispatchEvent: (event: RealtimeClientEvent) => void,
  requestTokenFn: () => Promise<RealtimeSubscribeTokenDto | null> = requestRealtimeToken,
): () => void {
  let disposed = false;
  let ablyClient: PubSubClient | null = null;
  let eventSource: EventSource | null = null;
  let channelUnsubscribe: (() => void) | null = null;

  const closePhysical = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    activeConnections.delete(closePhysical);

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

  activeConnections.add(closePhysical);

  void (async () => {
    const initialToken = await requestTokenFn();
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
        'notification.deleted',
        'chat.message.created',
        'chat.conversation.read',
        'chat.conversation.updated',
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
              dispatchEvent({ event: eventName, data: parsed });
            }
          } catch {
            // Bỏ qua frame không hợp lệ.
          }
        });
      }
      return;
    }

    if (initialToken.provider === 'ably' && initialToken.tokenRequest) {
      const { createClient } = await import('@ably/pubsub-device');
      if (disposed || typeof createClient !== 'function') {
        return;
      }

      let cachedInitialTokenRequest: TokenRequest | null =
        initialToken.tokenRequest as TokenRequest;

      const client = createClient({
        autoConnect: true,
        ...(initialToken.tokenRequest.clientId
          ? { clientId: initialToken.tokenRequest.clientId }
          : {}),
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
          void requestTokenFn().then((fresh) => {
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
          dispatchEvent({
            event: message.name as RealtimeEventName,
            data: message.data,
          });
        }
      };

      // Bắt rõ rejection từ Promise của `channel.subscribe` (ví dụ `Connection closed` khi
      // người dùng chuyển trang hoặc đăng xuất trong lúc kênh đang gắn) để không gây Unhandled Rejection.
      void Promise.resolve(channel.subscribe(handleInbound)).catch(() => undefined);
      channelUnsubscribe = () => {
        channel.unsubscribe(handleInbound);
      };
    }
  })().catch(() => undefined);

  return closePhysical;
}

/**
 * Thiết lập kết nối Realtime chỉ-nghe (subscribe-only) tới kênh cá nhân `user:{publicId}`:
 * - Hỗ trợ Multiplexer theo `userPublicId`: giữ kết nối sống xuyên suốt khi chuyển trang nội bộ (`/` <-> `/messages`).
 * - Đóng kết nối vật lý ngay lập tức và xóa sạch `subscribers` khi đổi `userPublicId` hoặc đăng xuất.
 */
export function connectUserRealtime(options: ConnectRealtimeOptions): RealtimeClientConnection {
  const normalizedUserId = (options.userPublicId ?? '').trim().toLowerCase();

  // Nếu không truyền `userPublicId`, tạo kết nối độc lập không dùng chung.
  if (!normalizedUserId) {
    const closePhysical = openPhysicalRealtimeConnection(options.onEvent, options.requestTokenFn);
    return { disconnect: closePhysical };
  }

  // Nếu đang có kết nối dùng chung của một tài khoản KHÁC -> đóng ngay lập tức (không chờ 1500ms).
  if (
    activeSharedMultiplexer &&
    (activeSharedMultiplexer.userPublicId !== normalizedUserId || activeSharedMultiplexer.disposed)
  ) {
    destroySharedMultiplexerImmediate(activeSharedMultiplexer);
  }

  let mux = activeSharedMultiplexer;
  if (!mux) {
    const subscribers = new Set<(event: RealtimeClientEvent) => void>();
    const dispatchToSubscribers = (event: RealtimeClientEvent) => {
      for (const sub of Array.from(subscribers)) {
        try {
          sub(event);
        } catch {
          // Cô lập lỗi của từng listener để không làm gián đoạn các listener khác.
        }
      }
    };

    const closePhysical = openPhysicalRealtimeConnection(
      dispatchToSubscribers,
      options.requestTokenFn,
    );

    mux = {
      userPublicId: normalizedUserId,
      subscribers,
      graceCloseTimer: null,
      disposed: false,
      closePhysicalConnection: () => {
        mux!.disposed = true;
        closePhysical();
      },
    };
    activeSharedMultiplexer = mux;
  }

  if (mux.graceCloseTimer !== null) {
    clearTimeout(mux.graceCloseTimer);
    mux.graceCloseTimer = null;
  }

  mux.subscribers.add(options.onEvent);

  let subscriberRemoved = false;
  const targetMux = mux;

  const disconnect = () => {
    if (subscriberRemoved) {
      return;
    }
    subscriberRemoved = true;
    targetMux.subscribers.delete(options.onEvent);

    if (targetMux.disposed) {
      return;
    }

    if (targetMux.subscribers.size === 0) {
      if (targetMux.graceCloseTimer !== null) {
        clearTimeout(targetMux.graceCloseTimer);
      }
      targetMux.graceCloseTimer = setTimeout(() => {
        targetMux.graceCloseTimer = null;
        if (targetMux.subscribers.size === 0 && !targetMux.disposed) {
          destroySharedMultiplexerImmediate(targetMux);
        }
      }, REALTIME_MULTIPLEX_GRACE_MS);
    }
  };

  return { disconnect };
}
