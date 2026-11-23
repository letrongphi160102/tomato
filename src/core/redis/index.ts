import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { logger } from '@/core/logger';
import { LocalRedisAdapter } from '@/core/redis/local-adapter';
import {
  LOGIN_BACKOFF_SCHEDULE_SECONDS,
  LOGIN_BACKOFF_START_ATTEMPT,
  LOGIN_CAPTCHA_REQUIRED_ATTEMPT,
  LOGIN_PAIR_FAILURE_TTL_SECONDS,
  LoginBruteForceGuard,
  computeLoginBackoffSeconds,
  hashLoginPairKey,
  isCaptchaRequiredForFailureCount,
  type LoginBruteForceGuardOptions,
  type LoginBruteForceState,
  type LoginBruteForceStore,
  type LoginFailureRecordResult,
} from '@/core/redis/login-brute-force';
import {
  AUTH_RATE_LIMITS,
  PROFILE_RATE_LIMITS,
  SOCIAL_RATE_LIMITS,
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
  PROFILE_RATE_LIMITS,
  SOCIAL_RATE_LIMITS,
  LOGIN_BACKOFF_SCHEDULE_SECONDS,
  LOGIN_BACKOFF_START_ATTEMPT,
  LOGIN_CAPTCHA_REQUIRED_ATTEMPT,
  LOGIN_PAIR_FAILURE_TTL_SECONDS,
  LoginBruteForceGuard,
  RateLimiter,
  computeLoginBackoffSeconds,
  hashLoginPairKey,
  isCaptchaRequiredForFailureCount,
  type LoginBruteForceGuardOptions,
  type LoginBruteForceState,
  type LoginBruteForceStore,
  type LoginFailureRecordResult,
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
  __tomatoLoginBruteForceGuard?: LoginBruteForceGuard;
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

export function getLoginBruteForceGuard(): LoginBruteForceGuard {
  if (!globalForRedis.__tomatoLoginBruteForceGuard) {
    globalForRedis.__tomatoLoginBruteForceGuard = new LoginBruteForceGuard(getRedisClient());
  }
  return globalForRedis.__tomatoLoginBruteForceGuard;
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
    const errObj =
      typeof error === 'object' && error !== null
        ? (error as { readonly code?: unknown; readonly name?: unknown })
        : null;
    logger.error(
      {
        component: 'redis',
        errorCode:
          typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
            ? errObj.code
            : 'HEALTHCHECK_FAILED',
        errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
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
  globalForRedis.__tomatoLoginBruteForceGuard = undefined;
  if (globalForRedis.__tomatoRedisClient) {
    const client = globalForRedis.__tomatoRedisClient;
    globalForRedis.__tomatoRedisClient = undefined;
    await client.close();
  }
}
