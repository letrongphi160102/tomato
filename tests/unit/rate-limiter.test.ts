import { describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/core/redis/rate-limiter';
import type { RedisClient } from '@/core/redis/types';

function createMockRedisForRateLimiter(evalImpl: RedisClient['eval']): RedisClient {
  return {
    provider: 'local',
    ping: vi.fn(async () => 'PONG'),
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK' as const),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    pexpire: vi.fn(async () => 1),
    pttl: vi.fn(async () => -1),
    eval: evalImpl,
    close: vi.fn(async () => undefined),
  };
}

describe('RateLimiter (Sliding Window & Fixed Window)', () => {
  it('chạy sliding_window mặc định với 2 khóa cửa sổ liền kề và trả retryAfterSeconds khi vượt ngưỡng', async () => {
    const evalSpy = vi
      .fn()
      .mockResolvedValueOnce([1, 2, 40_000])
      .mockResolvedValueOnce([0, 0, 12_300]);

    const nowMs = 1_760_000_020_000;
    const limiter = new RateLimiter(createMockRedisForRateLimiter(evalSpy), {
      keyPrefix: 'test:rl',
      now: () => nowMs,
    });

    const first = await limiter.consume('login:ip:127.0.0.1', {
      limit: 3,
      windowSeconds: 60,
    });

    expect(first).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetAt: nowMs + 40_000,
      retryAfterSeconds: 0,
    });

    const [script, keys, args] = evalSpy.mock.calls[0] as [string, string[], number[]];
    expect(script).toContain('weightedPrev');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^test:rl:sw:login:ip:127\.0\.0\.1:\d+$/);
    expect(args).toEqual([3, 60_000, nowMs % 60_000]);

    const blocked = await limiter.consume('login:ip:127.0.0.1', {
      limit: 3,
      windowSeconds: 60,
    });

    expect(blocked).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: nowMs + 12_300,
      retryAfterSeconds: 13,
    });
  });

  it('hỗ trợ fixed_window và làm tròn lên retryAfterSeconds (>= 1 giây)', async () => {
    const evalSpy = vi.fn().mockResolvedValueOnce([0, 0, 250]);
    const nowMs = 1_760_000_000_000;

    const limiter = new RateLimiter(createMockRedisForRateLimiter(evalSpy), {
      keyPrefix: 'test:rl',
      now: () => nowMs,
    });

    const result = await limiter.consume('resend:cooldown:user-1', {
      limit: 1,
      windowSeconds: 60,
      strategy: 'fixed_window',
    });

    expect(result).toEqual({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetAt: nowMs + 250,
      retryAfterSeconds: 1,
    });

    const [, keys, args] = evalSpy.mock.calls[0] as [string, string[], number[]];
    expect(keys).toEqual(['test:rl:fw:resend:cooldown:user-1']);
    expect(args).toEqual([1, 60_000]);
  });

  it('từ chối rule không hợp lệ (key rỗng, limit <= 0, windowSeconds <= 0)', async () => {
    const limiter = new RateLimiter(createMockRedisForRateLimiter(vi.fn()));

    await expect(limiter.consume('   ', { limit: 5, windowSeconds: 60 })).rejects.toThrow();
    await expect(limiter.consume('k', { limit: 0, windowSeconds: 60 })).rejects.toThrow(RangeError);
    await expect(limiter.consume('k', { limit: 5, windowSeconds: -1 })).rejects.toThrow(RangeError);
  });
});
