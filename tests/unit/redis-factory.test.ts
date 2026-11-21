import { describe, expect, it } from 'vitest';

import { createRedisClient } from '@/core/redis';
import { LocalRedisAdapter } from '@/core/redis/local-adapter';
import { UpstashRedisAdapter } from '@/core/redis/upstash-adapter';

describe('createRedisClient (Port & Adapter factory)', () => {
  it('khởi tạo LocalRedisAdapter khi REDIS_PROVIDER=local', async () => {
    const client = createRedisClient({
      REDIS_PROVIDER: 'local',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });

    expect(client).toBeInstanceOf(LocalRedisAdapter);
    expect(client.provider).toBe('local');
    await client.close();
  });

  it('khởi tạo UpstashRedisAdapter khi REDIS_PROVIDER=upstash', async () => {
    const client = createRedisClient({
      REDIS_PROVIDER: 'upstash',
      UPSTASH_REDIS_REST_URL: 'https://example-upstash.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'synthetic-upstash-token-for-unit-test',
    });

    expect(client).toBeInstanceOf(UpstashRedisAdapter);
    expect(client.provider).toBe('upstash');
    await client.close();
  });

  it('ném lỗi khi thiếu thông tin kết nối cho provider đã chọn', () => {
    expect(() =>
      createRedisClient({
        REDIS_PROVIDER: 'local',
        REDIS_URL: undefined,
      }),
    ).toThrow();

    expect(() =>
      createRedisClient({
        REDIS_PROVIDER: 'upstash',
        UPSTASH_REDIS_REST_URL: undefined,
        UPSTASH_REDIS_REST_TOKEN: undefined,
      }),
    ).toThrow();
  });
});
