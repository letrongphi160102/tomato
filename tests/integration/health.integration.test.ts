import { afterAll, describe, expect, it } from 'vitest';

import { GET } from '@/app/api/health/route';
import { closeDatabasePool } from '@/core/db';
import { closeRedisClient, getRedisClient } from '@/core/redis';

describe('Integration M0: PostgreSQL, Redis Adapter & GET /api/health', () => {
  afterAll(async () => {
    await Promise.all([closeDatabasePool(), closeRedisClient()]);
  });

  it('GET /api/health kết nối thực tế tới PostgreSQL và Redis và trả 200 OK', async () => {
    const response = await GET();
    const body = (await response.json()) as {
      status: string;
      checks: { database: string; redis: string };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'up', redis: 'up' });
  });

  it('Redis adapter hỗ trợ đầy đủ vòng đời lệnh cơ bản và Lua eval atomic', async () => {
    const redis = getRedisClient();
    const testKey = `tomato:m0:health-test:${Date.now()}`;

    try {
      expect(await redis.ping()).toBe('PONG');
      expect(await redis.set(testKey, '012345', { ex: 30 })).toBe('OK');
      // Đảm bảo chuỗi bắt đầu bằng số 0 không bị ép kiểu sang number.
      expect(await redis.get(testKey)).toBe('012345');

      const luaResult = await redis.eval<number>(
        'return redis.call("INCR", KEYS[1])',
        [`${testKey}:counter`],
        [],
      );
      expect(Number(luaResult)).toBe(1);
    } finally {
      await redis.del(testKey, `${testKey}:counter`);
    }
  });
});
