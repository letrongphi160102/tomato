import { NextResponse } from 'next/server';

import { checkDatabaseHealth } from '@/core/db';
import { checkRedisHealth } from '@/core/redis';

// Bắt buộc dùng Node.js Runtime vì truy vấn PostgreSQL TCP (pg) và Local Redis TCP (ioredis).
export const runtime = 'nodejs';
// Luôn kiểm tra trạng thái thực tế ở mỗi request, tuyệt đối không cache tĩnh.
export const dynamic = 'force-dynamic';

type ServiceState = 'up' | 'down';

interface HealthPayload {
  status: 'ok' | 'degraded';
  checks: {
    database: ServiceState;
    redis: ServiceState;
  };
  timestamp: string;
}

export async function GET(): Promise<NextResponse<HealthPayload>> {
  const [dbHealthy, redisHealthy] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

  const allHealthy = dbHealthy && redisHealthy;

  // Chỉ trả trạng thái tổng quan; chi tiết lỗi kỹ thuật chỉ được ghi vào Pino log phía server
  // nhằm tránh lộ thông tin hạ tầng (connection string, host, stack trace).
  const payload: HealthPayload = {
    status: allHealthy ? 'ok' : 'degraded',
    checks: {
      database: dbHealthy ? 'up' : 'down',
      redis: redisHealthy ? 'up' : 'down',
    },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(payload, {
    status: allHealthy ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
