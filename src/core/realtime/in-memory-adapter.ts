import 'server-only';

import {
  assertRealtimePayloadSafe,
  buildUserRealtimeChannel,
  normalizeRealtimeUserPublicId,
} from '@/core/realtime/channel';
import {
  REALTIME_TOKEN_TTL_MS,
  type LocalRealtimeEventMessage,
  type LocalRealtimeListener,
  type RealtimeEventName,
  type RealtimeProvider,
  type RealtimeSubscribeTokenDto,
} from '@/core/realtime/types';

export const LOCAL_REALTIME_STREAM_URL = '/api/v1/realtime/stream';

const MAX_RECORDED_EVENTS = 200;

interface SharedLocalRealtimeBus {
  readonly listenersByChannel: Map<string, Set<LocalRealtimeListener>>;
  readonly recentEvents: LocalRealtimeEventMessage[];
}

const globalForRealtimeBus = globalThis as typeof globalThis & {
  __tomatoLocalRealtimeBus?: SharedLocalRealtimeBus;
};

function getSharedLocalBus(): SharedLocalRealtimeBus {
  if (!globalForRealtimeBus.__tomatoLocalRealtimeBus) {
    globalForRealtimeBus.__tomatoLocalRealtimeBus = {
      listenersByChannel: new Map(),
      recentEvents: [],
    };
  }
  return globalForRealtimeBus.__tomatoLocalRealtimeBus;
}

export interface InMemoryRealtimeAdapterOptions {
  /** Tách bus riêng (hữu ích cho unit test song song). Mặc định dùng chung bus toàn tiến trình cho SSE local dev. */
  readonly isolated?: boolean;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Adapter Local Dev & CI (0đ, không cần tài khoản hay kết nối mạng ngoài):
 * - Kết hợp với endpoint SSE `/api/v1/realtime/stream` để đẩy thông báo tức thì trên máy local.
 * - Cô lập chặt chẽ theo từng kênh `user:{publicId}`.
 */
export class InMemoryRealtimeAdapter implements RealtimeProvider {
  public readonly provider = 'local' as const;
  private readonly bus: SharedLocalRealtimeBus;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: InMemoryRealtimeAdapterOptions = {}) {
    this.bus = options.isolated
      ? {
          listenersByChannel: new Map(),
          recentEvents: [],
        }
      : getSharedLocalBus();
    this.ttlMs = options.ttlMs ?? REALTIME_TOKEN_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async createSubscribeToken(actorPublicId: string): Promise<RealtimeSubscribeTokenDto> {
    const channel = buildUserRealtimeChannel(actorPublicId);
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();

    return {
      provider: this.provider,
      channel,
      expiresAt,
      ttlMs: this.ttlMs,
      streamUrl: LOCAL_REALTIME_STREAM_URL,
    };
  }

  async publishToUser<TPayload extends Record<string, unknown>>(
    recipientPublicId: string,
    eventName: RealtimeEventName,
    payload: TPayload,
  ): Promise<void> {
    const channel = buildUserRealtimeChannel(recipientPublicId);
    assertRealtimePayloadSafe(payload);

    const message: LocalRealtimeEventMessage = {
      channel,
      event: eventName,
      data: Object.freeze({ ...payload }),
      publishedAt: new Date(this.now()).toISOString(),
    };

    this.bus.recentEvents.push(message);
    if (this.bus.recentEvents.length > MAX_RECORDED_EVENTS) {
      this.bus.recentEvents.splice(0, this.bus.recentEvents.length - MAX_RECORDED_EVENTS);
    }

    const listeners = this.bus.listenersByChannel.get(channel);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of Array.from(listeners)) {
      try {
        listener(message);
      } catch {
        // Cô lập lỗi của từng kết nối SSE bị đóng đột ngột.
      }
    }
  }

  subscribeLocal(userPublicId: string, listener: LocalRealtimeListener): () => void {
    const channel = buildUserRealtimeChannel(userPublicId);
    let listeners = this.bus.listenersByChannel.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.bus.listenersByChannel.set(channel, listeners);
    }
    listeners.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const currentSet = this.bus.listenersByChannel.get(channel);
      if (!currentSet) {
        return;
      }
      currentSet.delete(listener);
      if (currentSet.size === 0) {
        this.bus.listenersByChannel.delete(channel);
      }
    };
  }

  getListenerCount(userPublicId: string): number {
    const channel = buildUserRealtimeChannel(normalizeRealtimeUserPublicId(userPublicId));
    return this.bus.listenersByChannel.get(channel)?.size ?? 0;
  }

  getPublishedEvents(): readonly LocalRealtimeEventMessage[] {
    return [...this.bus.recentEvents];
  }

  clearPublishedEvents(): void {
    this.bus.recentEvents.length = 0;
  }
}
