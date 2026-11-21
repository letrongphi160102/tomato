import 'server-only';

import Redis from 'ioredis';

import { logger } from '@/core/logger';
import type { RedisClient, RedisSetOptions } from '@/core/redis/types';

export class LocalRedisAdapter implements RedisClient {
  public readonly provider = 'local' as const;
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      // Fail-fast khi Redis local tắt thay vì xếp hàng lệnh vô hạn trong RAM.
      enableOfflineQueue: false,
    });

    this.client.on('error', (error: Error & { code?: string }) => {
      logger.error(
        {
          component: 'redis',
          provider: this.provider,
          errorCode: error.code ?? 'UNKNOWN',
          errorName: error.name,
        },
        'Lỗi kết nối Local Redis (TCP)',
      );
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }

  async ping(): Promise<string> {
    await this.ensureConnected();
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    await this.ensureConnected();

    if (options?.ex !== undefined && options.nx) {
      return this.client.set(key, value, 'EX', options.ex, 'NX');
    }
    if (options?.px !== undefined && options.nx) {
      return this.client.set(key, value, 'PX', options.px, 'NX');
    }
    if (options?.ex !== undefined) {
      return this.client.set(key, value, 'EX', options.ex);
    }
    if (options?.px !== undefined) {
      return this.client.set(key, value, 'PX', options.px);
    }
    if (options?.nx) {
      return this.client.set(key, value, 'NX');
    }
    return this.client.set(key, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    await this.ensureConnected();
    return this.client.del(...keys);
  }

  async incr(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    await this.ensureConnected();
    return this.client.expire(key, seconds);
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    await this.ensureConnected();
    return this.client.pexpire(key, milliseconds);
  }

  async pttl(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.pttl(key);
  }

  async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    await this.ensureConnected();
    return (await this.client.eval(script, keys.length, ...keys, ...args)) as T;
  }

  async close(): Promise<void> {
    // Chỉ gửi lệnh QUIT khi kết nối đang ở trạng thái 'ready';
    // với mọi trạng thái khác (wait/connecting/reconnecting/end), disconnect trực tiếp để tránh lỗi offline queue.
    if (this.client.status !== 'ready') {
      this.client.disconnect();
      return;
    }

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
