import 'server-only';

import { Redis as UpstashRedis } from '@upstash/redis';

import type { RedisClient, RedisSetOptions } from '@/core/redis/types';

export class UpstashRedisAdapter implements RedisClient {
  public readonly provider = 'upstash' as const;
  private readonly client: UpstashRedis;

  constructor(url: string, token: string) {
    // Tắt automaticDeserialization để giữ hành vi trả chuỗi thuần giống hệt ioredis TCP
    // (tránh việc chuỗi số như "012345" bị ép kiểu ngầm sang number).
    this.client = new UpstashRedis({
      url,
      token,
      automaticDeserialization: false,
    });
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    const value = await this.client.get<string>(key);
    return value === null ? null : String(value);
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) {
      return [];
    }
    const values = await this.client.mget<(string | null)[]>(...keys);
    return values.map((value) => (value === null || value === undefined ? null : String(value)));
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    let result: string | null;

    if (options?.ex !== undefined && options.nx) {
      result = await this.client.set(key, value, { ex: options.ex, nx: true });
    } else if (options?.px !== undefined && options.nx) {
      result = await this.client.set(key, value, { px: options.px, nx: true });
    } else if (options?.ex !== undefined) {
      result = await this.client.set(key, value, { ex: options.ex });
    } else if (options?.px !== undefined) {
      result = await this.client.set(key, value, { px: options.px });
    } else if (options?.nx) {
      result = await this.client.set(key, value, { nx: true });
    } else {
      result = await this.client.set(key, value);
    }

    return result === 'OK' ? 'OK' : null;
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return this.client.del(...keys);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    return this.client.pexpire(key, milliseconds);
  }

  async pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    return this.client.eval<unknown[], T>(script, keys, args);
  }

  async close(): Promise<void> {
    // Upstash REST giao tiếp qua HTTP stateless nên không giữ socket TCP cần đóng.
  }
}
