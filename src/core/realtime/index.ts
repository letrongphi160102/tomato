import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { getRateLimiter, type RateLimiter } from '@/core/redis';
import { AblyRealtimeAdapter, type AblyRealtimeAdapterOptions } from '@/core/realtime/ably-adapter';
import {
  assertRealtimePayloadSafe,
  buildSubscribeOnlyCapability,
  buildUserRealtimeChannel,
  normalizeRealtimeUserPublicId,
} from '@/core/realtime/channel';
import {
  InMemoryRealtimeAdapter,
  LOCAL_REALTIME_STREAM_URL,
  type InMemoryRealtimeAdapterOptions,
} from '@/core/realtime/in-memory-adapter';
import { authorizeRealtimeAction, type RealtimeAction } from '@/core/realtime/policy';
import {
  REALTIME_EVENT_NAMES,
  REALTIME_PROVIDER_TYPES,
  REALTIME_TOKEN_TTL_MS,
  type AblyTokenRequestDto,
  type LocalRealtimeEventMessage,
  type LocalRealtimeListener,
  type RealtimeEventName,
  type RealtimeProvider,
  type RealtimeProviderType,
  type RealtimeSubscribeTokenDto,
} from '@/core/realtime/types';

export {
  AblyRealtimeAdapter,
  InMemoryRealtimeAdapter,
  LOCAL_REALTIME_STREAM_URL,
  REALTIME_EVENT_NAMES,
  REALTIME_PROVIDER_TYPES,
  REALTIME_TOKEN_TTL_MS,
  assertRealtimePayloadSafe,
  authorizeRealtimeAction,
  buildSubscribeOnlyCapability,
  buildUserRealtimeChannel,
  normalizeRealtimeUserPublicId,
};
export type {
  AblyRealtimeAdapterOptions,
  AblyTokenRequestDto,
  InMemoryRealtimeAdapterOptions,
  LocalRealtimeEventMessage,
  LocalRealtimeListener,
  RealtimeAction,
  RealtimeEventName,
  RealtimeProvider,
  RealtimeProviderType,
  RealtimeSubscribeTokenDto,
};

type RealtimeEnvConfig = Pick<Env, 'REALTIME_PROVIDER' | 'ABLY_API_KEY'>;

export function createRealtimeProvider(config: RealtimeEnvConfig): RealtimeProvider {
  if (config.REALTIME_PROVIDER === 'ably') {
    if (!config.ABLY_API_KEY) {
      throw new Error('Thiếu ABLY_API_KEY khi REALTIME_PROVIDER=ably');
    }
    return new AblyRealtimeAdapter({ apiKey: config.ABLY_API_KEY });
  }

  return new InMemoryRealtimeAdapter();
}

const globalForRealtime = globalThis as typeof globalThis & {
  __tomatoRealtimeProvider?: RealtimeProvider;
  __tomatoRealtimeRateLimiter?: Pick<RateLimiter, 'consume'>;
};

export function getRealtimeProvider(): RealtimeProvider {
  if (!globalForRealtime.__tomatoRealtimeProvider) {
    globalForRealtime.__tomatoRealtimeProvider = createRealtimeProvider(getEnv());
  }
  return globalForRealtime.__tomatoRealtimeProvider;
}

export function getRealtimeRateLimiter(): Pick<RateLimiter, 'consume'> {
  return globalForRealtime.__tomatoRealtimeRateLimiter ?? getRateLimiter();
}

export function setRealtimeProviderForTesting(provider: RealtimeProvider): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setRealtimeProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForRealtime.__tomatoRealtimeProvider = provider;
}

export function setRealtimeRateLimiterForTesting(rateLimiter: Pick<RateLimiter, 'consume'>): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setRealtimeRateLimiterForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForRealtime.__tomatoRealtimeRateLimiter = rateLimiter;
}

export function resetRealtimeProviderForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetRealtimeProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForRealtime.__tomatoRealtimeProvider = undefined;
  globalForRealtime.__tomatoRealtimeRateLimiter = undefined;
}
