import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { logger } from '@/core/logger';
import { LocalRedisAdapter } from '@/core/redis/local-adapter';
import type { RedisClient } from '@/core/redis/types';
import { UpstashRedisAdapter } from '@/core/redis/upstash-adapter';

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
};

export function getRedisClient(): RedisClient {
  if (!globalForRedis.__tomatoRedisClient) {
    globalForRedis.__tomatoRedisClient = createRedisClient(getEnv());
  }
  return globalForRedis.__tomatoRedisClient;
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
  if (globalForRedis.__tomatoRedisClient) {
    const client = globalForRedis.__tomatoRedisClient;
    globalForRedis.__tomatoRedisClient = undefined;
    await client.close();
  }
}
