import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkDatabaseHealthMock, checkRedisHealthMock } = vi.hoisted(() => ({
  checkDatabaseHealthMock: vi.fn<() => Promise<boolean>>(),
  checkRedisHealthMock: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@/core/db', () => ({
  checkDatabaseHealth: checkDatabaseHealthMock,
}));

vi.mock('@/core/redis', () => ({
  checkRedisHealth: checkRedisHealthMock,
}));

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    checkDatabaseHealthMock.mockReset();
    checkRedisHealthMock.mockReset();
  });

  it('trả về 200 OK khi cả PostgreSQL và Redis đều khỏe', async () => {
    checkDatabaseHealthMock.mockResolvedValue(true);
    checkRedisHealthMock.mockResolvedValue(true);

    const response = await GET();
    const body = (await response.json()) as {
      status: string;
      checks: { database: string; redis: string };
      timestamp: string;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'up', redis: 'up' });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('trả về 503 Service Unavailable khi PostgreSQL lỗi', async () => {
    checkDatabaseHealthMock.mockResolvedValue(false);
    checkRedisHealthMock.mockResolvedValue(true);

    const response = await GET();
    const body = (await response.json()) as {
      status: string;
      checks: { database: string; redis: string };
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ database: 'down', redis: 'up' });
  });

  it('trả về 503 Service Unavailable khi Redis lỗi', async () => {
    checkDatabaseHealthMock.mockResolvedValue(true);
    checkRedisHealthMock.mockResolvedValue(false);

    const response = await GET();
    const body = (await response.json()) as {
      status: string;
      checks: { database: string; redis: string };
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ database: 'up', redis: 'down' });
  });
});
