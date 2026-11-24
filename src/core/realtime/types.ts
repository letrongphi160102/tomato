import type { TokenRequest } from '@ably/pubsub-server';

export const REALTIME_PROVIDER_TYPES = ['local', 'ably'] as const;

export type RealtimeProviderType = (typeof REALTIME_PROVIDER_TYPES)[number];

/**
 * Thời hạn Token Request Realtime khớp chặt với thời hạn Access Token (15 phút = 900.000 ms)
 * để siết vòng đời kết nối và buộc gia hạn qua phiên đã xác thực.
 */
export const REALTIME_TOKEN_TTL_MS = 15 * 60 * 1000;

export const REALTIME_EVENT_NAMES = [
  'notification.created',
  'notification.read',
  'notification.removed',
  'notification.deleted',
  'chat.message.created',
  'chat.message.updated',
  'chat.message.recalled',
  'chat.message.deleted_for_me',
  'chat.conversation.read',
  'chat.conversation.updated',
  'chat.conversation.deleted',
  'call.incoming',
  'call.accepted',
  'call.declined',
  'call.ended',
  'call.signal',
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];

/**
 * DTO allowlist cho Ably TokenRequest (khớp chuẩn `Ably.TokenRequest`, tuyệt đối không chứa secret key).
 */
export interface AblyTokenRequestDto {
  readonly keyName: TokenRequest['keyName'];
  readonly ttl?: TokenRequest['ttl'];
  readonly timestamp: TokenRequest['timestamp'];
  readonly capability: TokenRequest['capability'];
  readonly clientId?: TokenRequest['clientId'];
  readonly nonce: TokenRequest['nonce'];
  readonly mac: TokenRequest['mac'];
}

export interface RealtimeSubscribeTokenDto {
  readonly provider: RealtimeProviderType;
  /** Kênh cá nhân duy nhất mà client được phép subscribe: `user:${actor.publicId}`. */
  readonly channel: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
  readonly tokenRequest?: AblyTokenRequestDto;
  readonly streamUrl?: string;
}

export interface LocalRealtimeEventMessage {
  readonly channel: string;
  readonly event: RealtimeEventName;
  readonly data: Readonly<Record<string, unknown>>;
  readonly publishedAt: string;
}

export type LocalRealtimeListener = (message: LocalRealtimeEventMessage) => void;

export interface RealtimeProvider {
  readonly provider: RealtimeProviderType;
  /**
   * Cấp Token Request ngắn hạn (15 phút) với quyền DUY NHẤT `subscribe` trên kênh `user:${actorPublicId}`.
   * Tuyệt đối không cấp `publish`, không wildcard và không đọc kênh của người dùng khác.
   */
  createSubscribeToken(actorPublicId: string): Promise<RealtimeSubscribeTokenDto>;
  /**
   * Đẩy sự kiện nhẹ từ phía Server tới kênh riêng của 1 người dùng (`user:${recipientPublicId}`).
   */
  publishToUser<TPayload extends Record<string, unknown>>(
    recipientPublicId: string,
    eventName: RealtimeEventName,
    payload: TPayload,
  ): Promise<void>;
  /**
   * Đăng ký nhận sự kiện nội bộ cho adapter local/SSE và kiểm thử.
   */
  subscribeLocal?(userPublicId: string, listener: LocalRealtimeListener): () => void;
}
