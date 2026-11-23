import 'server-only';

import type { RedisClient } from '@/core/redis/types';

export type RateLimitStrategy = 'sliding_window' | 'fixed_window';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly strategy?: RateLimitStrategy;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Mốc thời gian Unix (milliseconds) dự kiến có thể thử lại hoặc reset cửa sổ. */
  readonly resetAt: number;
  /** Số giây tối thiểu client cần chờ trước khi thử lại (0 nếu được phép). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  readonly keyPrefix?: string;
  readonly now?: () => number;
}

/**
 * Các ngưỡng Rate Limit chuẩn hóa theo Mục 6.4 (chạy TRƯỚC khi truy vấn DB nặng hoặc Argon2id).
 */
export const AUTH_RATE_LIMITS = Object.freeze({
  registerByIp: Object.freeze({ limit: 5, windowSeconds: 15 * 60, strategy: 'sliding_window' }),
  loginByIp: Object.freeze({ limit: 10, windowSeconds: 15 * 60, strategy: 'sliding_window' }),
  refreshByIp: Object.freeze({ limit: 30, windowSeconds: 15 * 60, strategy: 'sliding_window' }),
  forgotPasswordByIp: Object.freeze({
    limit: 3,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  forgotPasswordByEmail: Object.freeze({
    limit: 3,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  resendVerificationByIp: Object.freeze({
    limit: 3,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  resendVerificationByEmail: Object.freeze({
    limit: 3,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  resendVerificationHourlyByEmail: Object.freeze({
    limit: 5,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  resendVerificationCooldown: Object.freeze({
    limit: 1,
    windowSeconds: 60,
    strategy: 'fixed_window',
  }),
  verifyEmailByIp: Object.freeze({
    limit: 30,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  verifyEmailByEmail: Object.freeze({
    limit: 15,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  resetPasswordByIp: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordOtpByIp: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordOtpCooldown: Object.freeze({
    limit: 1,
    windowSeconds: 60,
    strategy: 'fixed_window',
  }),
  changePasswordOtpByUserHourly: Object.freeze({
    limit: 5,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordVerifyOtpByIp: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordVerifyOtpByUser: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordByIp: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  changePasswordByUser: Object.freeze({
    limit: 10,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

/**
 * Các ngưỡng Rate Limit chuẩn hóa cho phân hệ Hồ sơ, Tìm kiếm & Ảnh đại diện (Giai đoạn 2 — M6).
 */
export const PROFILE_RATE_LIMITS = Object.freeze({
  searchByUser: Object.freeze({
    limit: 30,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  getProfileByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  updateProfileByUser: Object.freeze({
    limit: 20,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  uploadAvatarByUser: Object.freeze({
    limit: 5,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  deleteAvatarByUser: Object.freeze({
    limit: 10,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

/**
 * Các ngưỡng Rate Limit chuẩn hóa cho phân hệ Mạng lưới Kết nối, Riêng tư & Chặn (Giai đoạn 2 — M7).
 */
export const SOCIAL_RATE_LIMITS = Object.freeze({
  followActionByUser: Object.freeze({
    limit: 30,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  followRequestActionByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  socialListReadByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  blockActionByUser: Object.freeze({
    limit: 30,
    windowSeconds: 60 * 60,
    strategy: 'sliding_window',
  }),
  updatePrivacyByUser: Object.freeze({
    limit: 20,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

/**
 * Các ngưỡng Rate Limit chuẩn hóa cho phân hệ Realtime, Thông báo & Trạng thái Hoạt động (Giai đoạn 2 — M8).
 */
export const REALTIME_RATE_LIMITS = Object.freeze({
  issueTokenByUser: Object.freeze({
    limit: 30,
    windowSeconds: 15 * 60,
    strategy: 'sliding_window',
  }),
  openStreamByUser: Object.freeze({
    limit: 20,
    windowSeconds: 5 * 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

export const NOTIFICATION_RATE_LIMITS = Object.freeze({
  listByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  markReadByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  deleteByUser: Object.freeze({
    limit: 60,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

export const PRESENCE_RATE_LIMITS = Object.freeze({
  heartbeatByUser: Object.freeze({
    limit: 6,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
  queryByUser: Object.freeze({
    limit: 30,
    windowSeconds: 60,
    strategy: 'sliding_window',
  }),
} satisfies Record<string, RateLimitRule>);

// Lua script nguyên tử cho Fixed Window: kiểm tra giới hạn, chỉ tăng bộ đếm khi còn hạn mức
// và gán PEXPIRE ngay trong cùng 1 thao tác để tránh race condition hoặc key không có TTL.
const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key) or '0')
local pttl = tonumber(redis.call('PTTL', key))

if current >= limit then
  if pttl < 0 then
    redis.call('PEXPIRE', key, windowMs)
    pttl = windowMs
  end
  return { 0, 0, pttl }
end

local updated = tonumber(redis.call('INCR', key))
if updated == 1 or pttl < 0 then
  redis.call('PEXPIRE', key, windowMs)
  pttl = windowMs
end

local remaining = limit - updated
if remaining < 0 then
  remaining = 0
end

return { 1, remaining, pttl }
`;

// Lua script nguyên tử cho Sliding Window Counter (O(1) bộ nhớ, tương thích cả ioredis và Upstash REST):
// kết hợp trọng số cửa sổ trước + số lượng cửa sổ hiện tại để ngăn tấn công burst gấp đôi ở ranh giới cửa sổ.
const SLIDING_WINDOW_LUA = `
local currKey = KEYS[1]
local prevKey = KEYS[2]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local elapsedMs = tonumber(ARGV[3])

local currCount = tonumber(redis.call('GET', currKey) or '0')
local prevCount = tonumber(redis.call('GET', prevKey) or '0')

local remainingRatio = (windowMs - elapsedMs) / windowMs
local weightedPrev = math.floor(prevCount * remainingRatio)
local estimatedCount = weightedPrev + currCount

if estimatedCount >= limit then
  local waitMs = windowMs - elapsedMs
  if currCount < limit and prevCount > 0 then
    local neededHeadroom = limit - currCount
    local targetElapsed = math.floor(windowMs * (1 - (neededHeadroom / prevCount))) + 1
    local candidateWait = targetElapsed - elapsedMs
    if candidateWait > 0 and candidateWait < waitMs then
      waitMs = candidateWait
    end
  end
  if waitMs < 1 then
    waitMs = 1
  end
  return { 0, 0, waitMs }
end

local updatedCurr = tonumber(redis.call('INCR', currKey))
if updatedCurr == 1 then
  redis.call('PEXPIRE', currKey, windowMs * 2)
end

local remaining = limit - (weightedPrev + updatedCurr)
if remaining < 0 then
  remaining = 0
end

return { 1, remaining, windowMs - elapsedMs }
`;

function validateRule(key: string, rule: RateLimitRule): void {
  if (!key.trim()) {
    throw new Error('Rate limit key không được rỗng');
  }
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new RangeError('Rate limit `limit` phải là số nguyên dương');
  }
  if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds <= 0) {
    throw new RangeError('Rate limit `windowSeconds` phải là số nguyên dương');
  }
}

function parseLuaTuple(raw: unknown): [number, number, number] {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error('Kết quả Lua script RateLimiter không hợp lệ');
  }

  const allowedFlag = Number(raw[0]);
  const remaining = Number(raw[1]);
  const waitMs = Number(raw[2]);

  if (!Number.isFinite(allowedFlag) || !Number.isFinite(remaining) || !Number.isFinite(waitMs)) {
    throw new Error('Giá trị số trả về từ Lua script RateLimiter không hợp lệ');
  }

  return [allowedFlag, remaining, waitMs];
}

export class RateLimiter {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(redis: RedisClient, options: RateLimiterOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'tomato:rl';
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Tiêu thụ 1 lượt trên `key` bất kỳ theo chiến lược Sliding Window (mặc định) hoặc Fixed Window.
   */
  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    validateRule(key, rule);

    const strategy: RateLimitStrategy = rule.strategy ?? 'sliding_window';
    const windowMs = rule.windowSeconds * 1000;
    const nowMs = this.now();

    if (strategy === 'fixed_window') {
      const redisKey = `${this.keyPrefix}:fw:${key}`;
      const raw = await this.redis.eval<unknown>(
        FIXED_WINDOW_LUA,
        [redisKey],
        [rule.limit, windowMs],
      );
      const [allowedFlag, remaining, pttlMs] = parseLuaTuple(raw);
      const allowed = allowedFlag === 1;
      const safeWaitMs = Math.max(0, pttlMs);

      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, Math.floor(remaining)),
        resetAt: nowMs + safeWaitMs,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(safeWaitMs / 1000)),
      };
    }

    const currentWindowId = Math.floor(nowMs / windowMs);
    const elapsedMs = nowMs - currentWindowId * windowMs;
    const currKey = `${this.keyPrefix}:sw:${key}:${currentWindowId}`;
    const prevKey = `${this.keyPrefix}:sw:${key}:${currentWindowId - 1}`;

    const raw = await this.redis.eval<unknown>(
      SLIDING_WINDOW_LUA,
      [currKey, prevKey],
      [rule.limit, windowMs, elapsedMs],
    );
    const [allowedFlag, remaining, waitMs] = parseLuaTuple(raw);
    const allowed = allowedFlag === 1;
    const safeWaitMs = Math.max(0, waitMs);

    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, Math.floor(remaining)),
      resetAt: nowMs + safeWaitMs,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(safeWaitMs / 1000)),
    };
  }

  /**
   * Xóa bộ đếm Rate Limit hiện tại cho 1 key (dùng khi reset trạng thái hoặc dọn dẹp sau test).
   */
  async reset(key: string, rule: Pick<RateLimitRule, 'windowSeconds' | 'strategy'>): Promise<void> {
    const strategy: RateLimitStrategy = rule.strategy ?? 'sliding_window';
    if (strategy === 'fixed_window') {
      await this.redis.del(`${this.keyPrefix}:fw:${key}`);
      return;
    }

    const windowMs = rule.windowSeconds * 1000;
    const currentWindowId = Math.floor(this.now() / windowMs);
    await this.redis.del(
      `${this.keyPrefix}:sw:${key}:${currentWindowId}`,
      `${this.keyPrefix}:sw:${key}:${currentWindowId - 1}`,
    );
  }
}
