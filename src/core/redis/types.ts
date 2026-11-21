export interface RedisSetOptions {
  /** Thời gian hết hạn tính bằng giây (EX) */
  ex?: number;
  /** Thời gian hết hạn tính bằng mili-giây (PX) */
  px?: number;
  /** Chỉ ghi khi key chưa tồn tại (NX) */
  nx?: boolean;
}

export type RedisProviderType = 'local' | 'upstash';

/**
 * Port trừu tượng dùng chung giữa Local Redis (TCP qua ioredis)
 * và Production Upstash Redis (HTTP REST qua @upstash/redis).
 */
export interface RedisClient {
  readonly provider: RedisProviderType;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
  close(): Promise<void>;
}
