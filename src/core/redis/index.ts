import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { logger } from '@/core/logger';
import { LocalRedisAdapter } from '@/core/redis/local-adapter';
import {
  AUTH_RATE_LIMITS,
  RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStrategy,
  type RateLimiterOptions,
} from '@/core/redis/rate-limiter';
import type { RedisClient } from '@/core/redis/types';
import { UpstashRedisAdapter } from '@/core/redis/upstash-adapter';

export {
  AUTH_RATE_LIMITS,
  RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStrategy,
  type RateLimiterOptions,
};
export type { RedisClient, RedisProviderType, RedisSetOptions } from '@/core/redis/types';

type RedisEnvConfig = Pick<
  Env,
  'REDIS_PROVIDER' | 'REDIS_URL' | 'UPSTASH_REDIS_REST_URL' | 'UPSTASH_REDIS_REST_TOKEN'
>;

export function createRedisClient(config: RedisEnvConfig): RedisClient {
  if (config.REDIS_PROVIDER === 'upstash') {
    if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('Thiếu UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN');
    }
    return new UpstashRedisAdapter(config.UPSTASH_REDIS_REST_URL, config.UPSTASH_REDIS_REST_TOKEN);
  }

  if (!config.REDIS_URL) {
    throw new Error('Thiếu REDIS_URL cho Local Redis adapter');
  }
  return new LocalRedisAdapter(config.REDIS_URL);
}

const globalForRedis = globalThis as typeof globalThis & {
  __tomatoRedisClient?: RedisClient;
  __tomatoRateLimiter?: RateLimiter;
};

export function getRedisClient(): RedisClient {
  if (!globalForRedis.__tomatoRedisClient) {
    globalForRedis.__tomatoRedisClient = createRedisClient(getEnv());
  }
  return globalForRedis.__tomatoRedisClient;
}

export function getRateLimiter(): RateLimiter {
  if (!globalForRedis.__tomatoRateLimiter) {
    globalForRedis.__tomatoRateLimiter = new RateLimiter(getRedisClient());
  }
  return globalForRedis.__tomatoRateLimiter;
}

export async function checkRedisHealth(timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const client = getRedisClient();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('REDIS_HEALTHCHECK_TIMEOUT')), timeoutMs);
    });

    const pong = await Promise.race([client.ping(), timeoutPromise]);
    return pong === 'PONG';
  } catch (error) {
    const err = error as Error & { code?: string };
    logger.error(
      {
        component: 'redis',
        errorCode: err.code ?? 'HEALTHCHECK_FAILED',
        errorName: err.name ?? 'Error',
      },
      'Kiểm tra kết nối Redis thất bại',
    );
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closeRedisClient(): Promise<void> {
  globalForRedis.__tomatoRateLimiter = undefined;
  if (globalForRedis.__tomatoRedisClient) {
    const client = globalForRedis.__tomatoRedisClient;
    globalForRedis.__tomatoRedisClient = undefined;
    await client.close();
  }
}
