import { describe, expect, it } from 'vitest';

import {
  LOGIN_BACKOFF_SCHEDULE_SECONDS,
  LoginBruteForceGuard,
  computeLoginBackoffSeconds,
  hashLoginPairKey,
  isCaptchaRequiredForFailureCount,
  type RedisClient,
} from '@/core/redis';

/**
 * Giả lập tối giản Redis client hỗ trợ đúng 2 Lua script của LoginBruteForceGuard
 * để kiểm thử đơn vị thuần túy không phụ thuộc Docker.
 */
function createInMemoryBruteForceRedis(now: () => number): RedisClient {
  const store = new Map<string, { value: string; expiresAtMs?: number }>();

  function getAlive(key: string): string | null {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    provider: 'local',
    async ping() {
      return 'PONG';
    },
    async get(key) {
      return getAlive(key);
    },
    async set(key, value, options) {
      const expiresAtMs =
        options?.px !== undefined
          ? now() + options.px
          : options?.ex !== undefined
            ? now() + options.ex * 1000
            : undefined;
      store.set(key, { value, expiresAtMs });
      return 'OK';
    },
    async del(...keys) {
      let removed = 0;
      for (const k of keys) {
        if (store.delete(k)) {
          removed += 1;
        }
      }
      return removed;
    },
    async incr(key) {
      const next = Number(getAlive(key) ?? '0') + 1;
      const existing = store.get(key);
      store.set(key, { value: String(next), expiresAtMs: existing?.expiresAtMs });
      return next;
    },
    async expire(key, seconds) {
      const existing = store.get(key);
      if (!existing) {
        return 0;
      }
      existing.expiresAtMs = now() + seconds * 1000;
      return 1;
    },
    async pexpire(key, ms) {
      const existing = store.get(key);
      if (!existing) {
        return 0;
      }
      existing.expiresAtMs = now() + ms;
      return 1;
    },
    async pttl(key) {
      const entry = store.get(key);
      if (!entry) {
        return -2;
      }
      if (entry.expiresAtMs === undefined) {
        return -1;
      }
      return Math.max(0, entry.expiresAtMs - now());
    },
    async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
      const failKey = keys[0]!;
      const backoffKey = keys[1]!;

      if (script.includes("redis.call('INCR', failKey)")) {
        const pairTtlMs = Number(args[0]);
        const nowMs = Number(args[1]);
        const count = Number(getAlive(failKey) ?? '0') + 1;
        store.set(failKey, { value: String(count), expiresAtMs: nowMs + pairTtlMs });

        const backoffSec = computeLoginBackoffSeconds(count);
        if (backoffSec > 0) {
          const backoffMs = backoffSec * 1000;
          store.set(backoffKey, {
            value: String(nowMs + backoffMs),
            expiresAtMs: nowMs + backoffMs,
          });
        }

        return [count, backoffSec] as T;
      }

      const nowMs = Number(args[0]);
      const count = Number(getAlive(failKey) ?? '0');
      const rawUntil = getAlive(backoffKey);
      let remainingMs = 0;
      if (rawUntil) {
        const untilMs = Number(rawUntil);
        if (Number.isFinite(untilMs) && untilMs > nowMs) {
          remainingMs = untilMs - nowMs;
        } else {
          store.delete(backoffKey);
        }
      }
      return [count, remainingMs] as T;
    },
    async close() {},
  };
}

describe('Unit M5: LoginBruteForceGuard — Exponential Backoff (1s->2s->4s->8s) & Turnstile ngưỡng 5', () => {
  it('computeLoginBackoffSeconds và isCaptchaRequiredForFailureCount đúng đặc tả Mục 4.2 & 6.4', () => {
    expect(LOGIN_BACKOFF_SCHEDULE_SECONDS).toEqual([1, 2, 4, 8]);
    expect(computeLoginBackoffSeconds(0)).toBe(0);
    expect(computeLoginBackoffSeconds(1)).toBe(0);
    expect(computeLoginBackoffSeconds(2)).toBe(0);
    expect(computeLoginBackoffSeconds(3)).toBe(1);
    expect(computeLoginBackoffSeconds(4)).toBe(2);
    expect(computeLoginBackoffSeconds(5)).toBe(4);
    expect(computeLoginBackoffSeconds(6)).toBe(8);
    expect(computeLoginBackoffSeconds(15)).toBe(8);

    expect(isCaptchaRequiredForFailureCount(4)).toBe(false);
    expect(isCaptchaRequiredForFailureCount(5)).toBe(true);
    expect(isCaptchaRequiredForFailureCount(10)).toBe(true);
  });

  it('hashLoginPairKey tách biệt hoàn toàn cặp (email + IP) và không lộ email PII', () => {
    const email = 'owner@tomato.test';
    const hashA = hashLoginPairKey(email, '198.51.100.1');
    const hashB = hashLoginPairKey(email, '198.51.100.2');

    expect(hashA).toHaveLength(64);
    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toContain('owner');
    expect(hashA).not.toContain('198.51.100.1');
  });

  it('áp dụng đúng tiến trình 1s -> 2s -> 4s -> 8s, bật requireCaptcha ở lần sai thứ 5, cô lập IP khác và xóa sạch khi clearPair', async () => {
    let clockMs = 1_700_000_000_000;
    const redis = createInMemoryBruteForceRedis(() => clockMs);
    const guard = new LoginBruteForceGuard(redis, {
      keyPrefix: 'tomato:bf:unit',
      now: () => clockMs,
    });

    const email = 'victim@tomato.test';
    const attackerIp = '203.0.113.99';
    const ownerIp = '198.51.100.10';

    // Lần sai 1 & 2: chưa backoff, chưa đòi Turnstile.
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 1,
      backoffSeconds: 0,
      requireCaptcha: false,
    });
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 2,
      backoffSeconds: 0,
      requireCaptcha: false,
    });
    expect((await guard.checkPair(email, attackerIp)).backoffRemainingMs).toBe(0);

    // Lần sai 3: kích hoạt backoff 1s.
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 3,
      backoffSeconds: 1,
      requireCaptcha: false,
    });
    const after3 = await guard.checkPair(email, attackerIp);
    expect(after3.backoffRemainingMs).toBe(1000);
    expect(after3.retryAfterSeconds).toBe(1);
    expect(after3.requireCaptcha).toBe(false);

    // Sau 1001ms: hết backoff -> lần sai 4 kích hoạt backoff 2s.
    clockMs += 1001;
    expect((await guard.checkPair(email, attackerIp)).backoffRemainingMs).toBe(0);
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 4,
      backoffSeconds: 2,
      requireCaptcha: false,
    });
    expect((await guard.checkPair(email, attackerIp)).retryAfterSeconds).toBe(2);

    // Sau 2001ms: lần sai 5 kích hoạt backoff 4s VÀ bật requireCaptcha = true.
    clockMs += 2001;
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 5,
      backoffSeconds: 4,
      requireCaptcha: true,
    });
    const after5 = await guard.checkPair(email, attackerIp);
    expect(after5.retryAfterSeconds).toBe(4);
    expect(after5.requireCaptcha).toBe(true);

    // Sau 4001ms: lần sai 6 kích hoạt backoff 8s (và giữ trần 8s).
    clockMs += 4001;
    expect(await guard.recordPairFailure(email, attackerIp)).toEqual({
      failureCount: 6,
      backoffSeconds: 8,
      requireCaptcha: true,
    });
    expect((await guard.checkPair(email, attackerIp)).retryAfterSeconds).toBe(8);

    // Chống DoS tài khoản chủ: IP chủ tài khoản hoàn toàn không bị chậm hay ép Turnstile!
    expect(await guard.checkPair(email, ownerIp)).toEqual({
      failureCount: 0,
      backoffRemainingMs: 0,
      retryAfterSeconds: 0,
      requireCaptcha: false,
    });

    // Khi đăng nhập thành công (clearPair) -> đặt lại trạng thái về 0.
    await guard.clearPair(email, attackerIp);
    expect(await guard.checkPair(email, attackerIp)).toEqual({
      failureCount: 0,
      backoffRemainingMs: 0,
      retryAfterSeconds: 0,
      requireCaptcha: false,
    });
  });
});
