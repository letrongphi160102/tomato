import 'server-only';

import type { RedisClient } from '@/core/redis/types';

export const PIN_RESET_OTP_TTL_SECONDS = 10 * 60;
export const PIN_RESET_OTP_TTL_MINUTES = 10;
export const PIN_RESET_OTP_MAX_ATTEMPTS = 5;
export const PIN_RESET_OTP_COOLDOWN_SECONDS = 60;

export interface PinResetOtpRecord {
  readonly otpHashHex: string;
  readonly attempts: number;
}

export interface PinResetOtpFailedAttemptResult {
  readonly exhausted: boolean;
  readonly remainingAttempts: number;
}

export interface PinResetOtpStore {
  issueOtp(userId: string, otpHashHex: string, ttlSeconds?: number): Promise<void>;
  getOtpRecord(userId: string): Promise<PinResetOtpRecord | null>;
  recordFailedAttempt(
    userId: string,
    expectedOtpHashHex: string,
    maxAttempts?: number,
  ): Promise<PinResetOtpFailedAttemptResult>;
  consumeOtpIfMatches(userId: string, expectedOtpHashHex: string): Promise<boolean>;
  clearOtp(userId: string): Promise<void>;
}

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

function parseStoredOtpRecord(raw: string | null): PinResetOtpRecord | null {
  if (!raw) {
    return null;
  }
  const sepIndex = raw.indexOf(':');
  if (sepIndex !== 64) {
    return null;
  }
  const otpHashHex = raw.slice(0, sepIndex).toLowerCase();
  const attempts = Number(raw.slice(sepIndex + 1));
  if (!SHA256_HEX_REGEX.test(otpHashHex) || !Number.isInteger(attempts) || attempts < 0) {
    return null;
  }
  return { otpHashHex, attempts };
}

// Xóa nguyên tử OTP trong Redis chỉ khi khớp đúng `otpHashHex` hiện tại (CAS + DEL),
// tương thích cả Upstash Redis REST (`automaticDeserialization: false`) lẫn Redis TCP (`ioredis`).
const CONSUME_OTP_CAS_LUA = `
local key = KEYS[1]
local expectedPrefix = ARGV[1]
local raw = redis.call('GET', key)
if not raw then
  return 0
end
if string.sub(raw, 1, #expectedPrefix) == expectedPrefix then
  redis.call('DEL', key)
  return 1
end
return 0
`;

// Tăng nguyên tử số lần nhập sai OTP và tự hủy ngay khi đạt ngưỡng `maxAttempts` (5),
// giữ nguyên TTL còn lại của khóa Redis.
const RECORD_FAILED_OTP_ATTEMPT_LUA = `
local key = KEYS[1]
local expectedPrefix = ARGV[1]
local maxAttempts = tonumber(ARGV[2])

local raw = redis.call('GET', key)
if not raw then
  return { 1, 0 }
end
if string.sub(raw, 1, #expectedPrefix) ~= expectedPrefix then
  return { 1, 0 }
end

local sepPos = string.find(raw, ':', 1, true)
if not sepPos then
  redis.call('DEL', key)
  return { 1, 0 }
end

local currAttempts = tonumber(string.sub(raw, sepPos + 1)) or 0
local nextAttempts = currAttempts + 1

if nextAttempts >= maxAttempts then
  redis.call('DEL', key)
  return { 1, 0 }
end

local pttl = tonumber(redis.call('PTTL', key))
if not pttl or pttl <= 0 then
  redis.call('DEL', key)
  return { 1, 0 }
end

redis.call('SET', key, expectedPrefix .. tostring(nextAttempts), 'PX', pttl)
return { 0, maxAttempts - nextAttempts }
`;

export interface RedisPinResetOtpStoreOptions {
  readonly keyPrefix?: string;
}

export class RedisPinResetOtpStore implements PinResetOtpStore {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;

  constructor(redis: RedisClient, options: RedisPinResetOtpStoreOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'tomato:e2ee:pin_reset_otp';
  }

  private buildKey(userId: string): string {
    return `${this.keyPrefix}:${userId.trim().toLowerCase()}`;
  }

  async issueOtp(
    userId: string,
    otpHashHex: string,
    ttlSeconds: number = PIN_RESET_OTP_TTL_SECONDS,
  ): Promise<void> {
    const normalizedHash = otpHashHex.trim().toLowerCase();
    if (!SHA256_HEX_REGEX.test(normalizedHash)) {
      throw new Error('Bản băm OTP không hợp lệ');
    }
    await this.redis.set(this.buildKey(userId), `${normalizedHash}:0`, { ex: ttlSeconds });
  }

  async getOtpRecord(userId: string): Promise<PinResetOtpRecord | null> {
    const raw = await this.redis.get(this.buildKey(userId));
    return parseStoredOtpRecord(raw);
  }

  async recordFailedAttempt(
    userId: string,
    expectedOtpHashHex: string,
    maxAttempts: number = PIN_RESET_OTP_MAX_ATTEMPTS,
  ): Promise<PinResetOtpFailedAttemptResult> {
    const expectedPrefix = `${expectedOtpHashHex.trim().toLowerCase()}:`;
    const raw = await this.redis.eval<unknown>(
      RECORD_FAILED_OTP_ATTEMPT_LUA,
      [this.buildKey(userId)],
      [expectedPrefix, maxAttempts],
    );
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error('Kết quả Lua script RedisPinResetOtpStore không hợp lệ');
    }
    const exhaustedFlag = Number(raw[0]);
    const remainingAttempts = Number(raw[1]);
    return {
      exhausted: exhaustedFlag === 1,
      remainingAttempts: Number.isFinite(remainingAttempts)
        ? Math.max(0, Math.floor(remainingAttempts))
        : 0,
    };
  }

  async consumeOtpIfMatches(userId: string, expectedOtpHashHex: string): Promise<boolean> {
    const expectedPrefix = `${expectedOtpHashHex.trim().toLowerCase()}:`;
    const raw = await this.redis.eval<unknown>(
      CONSUME_OTP_CAS_LUA,
      [this.buildKey(userId)],
      [expectedPrefix],
    );
    return Number(raw) === 1;
  }

  async clearOtp(userId: string): Promise<void> {
    await this.redis.del(this.buildKey(userId));
  }
}

/**
 * Bộ lưu OTP trong RAM dành cho Unit/Security test (CI độc lập không cần Redis):
 * mô phỏng chính xác 100% ngữ nghĩa TTL, CAS + DEL nguyên tử và hủy sau 5 lần sai của `RedisPinResetOtpStore`.
 */
export class InMemoryPinResetOtpStore implements PinResetOtpStore {
  private readonly entries = new Map<
    string,
    { readonly otpHashHex: string; attempts: number; readonly expiresAtMs: number }
  >();
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private normalizeUserId(userId: string): string {
    return userId.trim().toLowerCase();
  }

  private readActive(userId: string) {
    const key = this.normalizeUserId(userId);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.now() >= entry.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async issueOtp(
    userId: string,
    otpHashHex: string,
    ttlSeconds: number = PIN_RESET_OTP_TTL_SECONDS,
  ): Promise<void> {
    const key = this.normalizeUserId(userId);
    this.entries.set(key, {
      otpHashHex: otpHashHex.trim().toLowerCase(),
      attempts: 0,
      expiresAtMs: this.now() + ttlSeconds * 1000,
    });
  }

  async getOtpRecord(userId: string): Promise<PinResetOtpRecord | null> {
    const entry = this.readActive(userId);
    if (!entry) {
      return null;
    }
    return {
      otpHashHex: entry.otpHashHex,
      attempts: entry.attempts,
    };
  }

  async recordFailedAttempt(
    userId: string,
    expectedOtpHashHex: string,
    maxAttempts: number = PIN_RESET_OTP_MAX_ATTEMPTS,
  ): Promise<PinResetOtpFailedAttemptResult> {
    const key = this.normalizeUserId(userId);
    const entry = this.readActive(userId);
    if (!entry || entry.otpHashHex !== expectedOtpHashHex.trim().toLowerCase()) {
      return { exhausted: true, remainingAttempts: 0 };
    }
    entry.attempts += 1;
    if (entry.attempts >= maxAttempts) {
      this.entries.delete(key);
      return { exhausted: true, remainingAttempts: 0 };
    }
    return {
      exhausted: false,
      remainingAttempts: Math.max(0, maxAttempts - entry.attempts),
    };
  }

  async consumeOtpIfMatches(userId: string, expectedOtpHashHex: string): Promise<boolean> {
    const key = this.normalizeUserId(userId);
    const entry = this.readActive(userId);
    if (!entry || entry.otpHashHex !== expectedOtpHashHex.trim().toLowerCase()) {
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  async clearOtp(userId: string): Promise<void> {
    this.entries.delete(this.normalizeUserId(userId));
  }
}
