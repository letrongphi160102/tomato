import 'server-only';

import { createHash } from 'node:crypto';

import type { RedisClient } from '@/core/redis/types';

export const LOGIN_BACKOFF_START_ATTEMPT = 3;
export const LOGIN_CAPTCHA_REQUIRED_ATTEMPT = 5;
export const LOGIN_BACKOFF_SCHEDULE_SECONDS = [1, 2, 4, 8] as const;
export const LOGIN_PAIR_FAILURE_TTL_SECONDS = 15 * 60;

export interface LoginBruteForceState {
  readonly failureCount: number;
  readonly backoffRemainingMs: number;
  readonly retryAfterSeconds: number;
  readonly requireCaptcha: boolean;
}

export interface LoginFailureRecordResult {
  readonly failureCount: number;
  readonly backoffSeconds: number;
  readonly requireCaptcha: boolean;
}

export interface LoginBruteForceStore {
  checkPair(emailNormalized: string, ipKey: string): Promise<LoginBruteForceState>;
  recordPairFailure(emailNormalized: string, ipKey: string): Promise<LoginFailureRecordResult>;
  clearPair(emailNormalized: string, ipKey: string): Promise<void>;
}

export interface LoginBruteForceGuardOptions {
  readonly keyPrefix?: string;
  readonly pairTtlSeconds?: number;
  readonly now?: () => number;
}

/**
 * Tính thời gian trễ Exponential Backoff (giây) cho cặp `(email + IP)` theo Mục 4.2 & 6.4:
 * - Lần sai 1–2: 0s
 * - Lần sai 3: 1s
 * - Lần sai 4: 2s
 * - Lần sai 5: 4s
 * - Lần sai >= 6: 8s (giới hạn trần 8s)
 */
export function computeLoginBackoffSeconds(failureCount: number): number {
  if (!Number.isInteger(failureCount) || failureCount < LOGIN_BACKOFF_START_ATTEMPT) {
    return 0;
  }
  const index = Math.min(
    failureCount - LOGIN_BACKOFF_START_ATTEMPT,
    LOGIN_BACKOFF_SCHEDULE_SECONDS.length - 1,
  );
  return LOGIN_BACKOFF_SCHEDULE_SECONDS[index] ?? 8;
}

/**
 * Từ lần sai thứ 5 trở đi trên cùng cặp `(email + IP)`, bắt buộc vượt qua Cloudflare Turnstile.
 */
export function isCaptchaRequiredForFailureCount(failureCount: number): boolean {
  return Number.isInteger(failureCount) && failureCount >= LOGIN_CAPTCHA_REQUIRED_ATTEMPT;
}

/**
 * Băm cặp `(email + IP)` bằng SHA-256 với ký tự phân cách NUL để:
 * 1. Không lưu email dạng rõ (PII) trong tên khóa Redis.
 * 2. Chống va chạm chuỗi khóa giữa các cặp `(email, IP)` khác nhau.
 */
export function hashLoginPairKey(emailNormalized: string, ipKey: string): string {
  return createHash('sha256').update(`${emailNormalized}\u0000${ipKey}`, 'utf8').digest('hex');
}

// Đọc nguyên tử số lần sai và thời gian backoff còn lại của cặp `(email + IP)`.
// Lưu mốc `backoffUntilMs` kết hợp TTL `PX` giúp hoạt động chính xác trên cả đồng hồ thực
// lẫn đồng hồ giả lập (`now`) trong test tự động, đồng thời không giữ kết nối serverless (chống Slowloris DoS).
const CHECK_PAIR_LUA = `
local failKey = KEYS[1]
local backoffKey = KEYS[2]
local nowMs = tonumber(ARGV[1])

local count = tonumber(redis.call('GET', failKey) or '0')
local rawUntil = redis.call('GET', backoffKey)
local remainingMs = 0

if rawUntil then
  local untilMs = tonumber(rawUntil)
  if untilMs and untilMs > nowMs then
    remainingMs = untilMs - nowMs
  else
    redis.call('DEL', backoffKey)
  end
end

return { count, remainingMs }
`;

// Tăng nguyên tử bộ đếm sai theo cặp `(email + IP)`, làm mới TTL 15 phút và thiết lập khóa
// Exponential Backoff (1s -> 2s -> 4s -> 8s) trong đúng 1 round-trip Lua tránh race condition.
const RECORD_FAILURE_LUA = `
local failKey = KEYS[1]
local backoffKey = KEYS[2]
local pairTtlMs = tonumber(ARGV[1])
local nowMs = tonumber(ARGV[2])

local count = tonumber(redis.call('INCR', failKey))
redis.call('PEXPIRE', failKey, pairTtlMs)

local backoffSec = 0
if count == 3 then
  backoffSec = 1
elseif count == 4 then
  backoffSec = 2
elseif count == 5 then
  backoffSec = 4
elseif count >= 6 then
  backoffSec = 8
end

if backoffSec > 0 then
  local backoffMs = backoffSec * 1000
  local backoffUntil = nowMs + backoffMs
  redis.call('SET', backoffKey, tostring(backoffUntil), 'PX', backoffMs)
end

return { count, backoffSec }
`;

function parsePairTuple(raw: unknown): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('Kết quả Lua script LoginBruteForceGuard không hợp lệ');
  }
  const first = Number(raw[0]);
  const second = Number(raw[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    throw new Error('Giá trị số trả về từ Lua script LoginBruteForceGuard không hợp lệ');
  }
  return [first, second];
}

/**
 * Bộ bảo vệ chống Brute-Force thông minh theo cặp `(email + IP)` trên Redis (Mục 4.2 & 6.4):
 * - Cô lập hoàn toàn theo `(email + IP)` để kẻ tấn công từ IP lạ không thể làm chậm (DoS)
 *   chủ tài khoản đang đăng nhập từ IP/thiết bị quen.
 * - Dùng Stateless Backoff Lock (`429 Retry-After`) thay cho `sleep()` phía server để không cạn
 *   Serverless concurrency trên Vercel Hobby.
 */
export class LoginBruteForceGuard implements LoginBruteForceStore {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;
  private readonly pairTtlMs: number;
  private readonly now: () => number;

  constructor(redis: RedisClient, options: LoginBruteForceGuardOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'tomato:bf';
    this.pairTtlMs = (options.pairTtlSeconds ?? LOGIN_PAIR_FAILURE_TTL_SECONDS) * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  private buildKeys(emailNormalized: string, ipKey: string): [string, string] {
    const pairHash = hashLoginPairKey(emailNormalized, ipKey);
    return [`${this.keyPrefix}:fail:${pairHash}`, `${this.keyPrefix}:backoff:${pairHash}`];
  }

  async checkPair(emailNormalized: string, ipKey: string): Promise<LoginBruteForceState> {
    const [failKey, backoffKey] = this.buildKeys(emailNormalized, ipKey);
    const raw = await this.redis.eval<unknown>(CHECK_PAIR_LUA, [failKey, backoffKey], [this.now()]);
    const [failureCount, remainingMs] = parsePairTuple(raw);
    const safeRemainingMs = Math.max(0, remainingMs);

    return {
      failureCount: Math.max(0, Math.floor(failureCount)),
      backoffRemainingMs: safeRemainingMs,
      retryAfterSeconds: safeRemainingMs > 0 ? Math.max(1, Math.ceil(safeRemainingMs / 1000)) : 0,
      requireCaptcha: isCaptchaRequiredForFailureCount(Math.floor(failureCount)),
    };
  }

  async recordPairFailure(
    emailNormalized: string,
    ipKey: string,
  ): Promise<LoginFailureRecordResult> {
    const [failKey, backoffKey] = this.buildKeys(emailNormalized, ipKey);
    const raw = await this.redis.eval<unknown>(
      RECORD_FAILURE_LUA,
      [failKey, backoffKey],
      [this.pairTtlMs, this.now()],
    );
    const [failureCount, backoffSeconds] = parsePairTuple(raw);
    const safeCount = Math.max(0, Math.floor(failureCount));

    return {
      failureCount: safeCount,
      backoffSeconds: Math.max(0, Math.floor(backoffSeconds)),
      requireCaptcha: isCaptchaRequiredForFailureCount(safeCount),
    };
  }

  async clearPair(emailNormalized: string, ipKey: string): Promise<void> {
    const [failKey, backoffKey] = this.buildKeys(emailNormalized, ipKey);
    await this.redis.del(failKey, backoffKey);
  }
}
