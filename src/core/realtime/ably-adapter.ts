import 'server-only';

import { createHttpClient, type PubSubHttpClient, type TokenRequest } from '@ably/pubsub-server';

import {
  assertRealtimePayloadSafe,
  buildSubscribeOnlyCapability,
  buildUserRealtimeChannel,
  normalizeRealtimeUserPublicId,
} from '@/core/realtime/channel';
import {
  REALTIME_TOKEN_TTL_MS,
  type AblyTokenRequestDto,
  type RealtimeEventName,
  type RealtimeProvider,
  type RealtimeSubscribeTokenDto,
} from '@/core/realtime/types';

export interface AblyRealtimeAdapterOptions {
  readonly apiKey: string;
  readonly client?: Pick<PubSubHttpClient, 'auth' | 'channels'>;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function toSafeTokenRequestDto(tokenRequest: TokenRequest): AblyTokenRequestDto {
  return {
    keyName: tokenRequest.keyName,
    ...(tokenRequest.ttl !== undefined ? { ttl: tokenRequest.ttl } : {}),
    timestamp: tokenRequest.timestamp,
    capability: tokenRequest.capability,
    ...(tokenRequest.clientId !== undefined ? { clientId: tokenRequest.clientId } : {}),
    nonce: tokenRequest.nonce,
    mac: tokenRequest.mac,
  };
}

/**
 * Adapter Production 0đ dùng Ably v3 Server HTTP SDK (`@ably/pubsub-server` — tương thích tài khoản MAU):
 * - Stateless HTTP phù hợp hoàn hảo với Vercel Serverless và được miễn tính MAU phía Server.
 * - Ký `TokenRequest` ngắn hạn (15 phút) bằng HMAC trên Server; `ABLY_API_KEY` tuyệt đối không rời Server.
 * - Khóa cứng `capability` chỉ có `["subscribe"]` trên đúng 1 kênh `user:{actor.publicId}` kèm `clientId`.
 */
export class AblyRealtimeAdapter implements RealtimeProvider {
  public readonly provider = 'ably' as const;
  private readonly client: Pick<PubSubHttpClient, 'auth' | 'channels'>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: AblyRealtimeAdapterOptions) {
    if (!options.client && !options.apiKey.trim()) {
      throw new Error('Thiếu ABLY_API_KEY khi khởi tạo AblyRealtimeAdapter');
    }
    this.client = options.client ?? createHttpClient({ key: options.apiKey });
    this.ttlMs = options.ttlMs ?? REALTIME_TOKEN_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async createSubscribeToken(actorPublicId: string): Promise<RealtimeSubscribeTokenDto> {
    const normalizedPublicId = normalizeRealtimeUserPublicId(actorPublicId);
    const channel = buildUserRealtimeChannel(normalizedPublicId);
    const capability = buildSubscribeOnlyCapability(channel);

    const tokenRequest = await this.client.auth.createTokenRequest({
      clientId: normalizedPublicId,
      ttl: this.ttlMs,
      capability,
    });

    const issuedTimestamp =
      typeof tokenRequest.timestamp === 'number' && Number.isFinite(tokenRequest.timestamp)
        ? tokenRequest.timestamp
        : this.now();
    const effectiveTtl =
      typeof tokenRequest.ttl === 'number' && tokenRequest.ttl > 0 ? tokenRequest.ttl : this.ttlMs;

    return {
      provider: this.provider,
      channel,
      expiresAt: new Date(issuedTimestamp + effectiveTtl).toISOString(),
      ttlMs: effectiveTtl,
      tokenRequest: toSafeTokenRequestDto(tokenRequest),
    };
  }

  async publishToUser<TPayload extends Record<string, unknown>>(
    recipientPublicId: string,
    eventName: RealtimeEventName,
    payload: TPayload,
  ): Promise<void> {
    const channel = buildUserRealtimeChannel(recipientPublicId);
    assertRealtimePayloadSafe(payload);
    await this.client.channels.get(channel).publish(eventName, payload);
  }
}
