import 'server-only';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getEnv } from '@/core/config/env';
import { normalizePostgresConnectionString } from '@/core/db/connection-string';
import * as schema from '@/core/db/schema';
import { logger } from '@/core/logger';

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbExecutor = Database | DatabaseTransaction;

export { normalizePostgresConnectionString } from '@/core/db/connection-string';
export {
  PG_ERROR_CODES,
  extractPostgresConstraintName,
  extractPostgresErrorCode,
  isPostgresUniqueViolation,
} from '@/core/db/errors';

const globalForDb = globalThis as typeof globalThis & {
  __tomatoPgPool?: Pool;
  __tomatoDrizzleDb?: Database;
};

function createDatabasePool(): Pool {
  const env = getEnv();

  const pool = new Pool({
    connectionString: normalizePostgresConnectionString(env.DATABASE_URL),
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    // Giới hạn thời gian chạy câu lệnh để tránh treo kết nối trên môi trường Serverless.
    statement_timeout: 5_000,
  });

  pool.on('error', (error: Error & { code?: string }) => {
    logger.error(
      {
        component: 'database',
        errorCode: error.code ?? 'UNKNOWN',
        errorName: error.name,
      },
      'Lỗi nền trên PostgreSQL connection pool',
    );
  });

  return pool;
}

export function getDatabasePool(): Pool {
  if (!globalForDb.__tomatoPgPool) {
    globalForDb.__tomatoPgPool = createDatabasePool();
  }
  return globalForDb.__tomatoPgPool;
}

export function getDb(): Database {
  if (!globalForDb.__tomatoDrizzleDb) {
    globalForDb.__tomatoDrizzleDb = drizzle(getDatabasePool(), { schema });
  }
  return globalForDb.__tomatoDrizzleDb;
}

export async function checkDatabaseHealth(timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const pool = getDatabasePool();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DATABASE_HEALTHCHECK_TIMEOUT')), timeoutMs);
    });

    await Promise.race([pool.query('SELECT 1'), timeoutPromise]);
    return true;
  } catch (error) {
    const errObj =
      typeof error === 'object' && error !== null
        ? (error as { readonly code?: unknown; readonly name?: unknown })
        : null;
    // Không log connection string hoặc thông số nhạy cảm; chỉ log mã lỗi chuẩn đoán.
    logger.error(
      {
        component: 'database',
        errorCode:
          typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
            ? errObj.code
            : 'HEALTHCHECK_FAILED',
        errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
      },
      'Kiểm tra kết nối PostgreSQL thất bại',
    );
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closeDatabasePool(): Promise<void> {
  globalForDb.__tomatoDrizzleDb = undefined;
  if (globalForDb.__tomatoPgPool) {
    const pool = globalForDb.__tomatoPgPool;
    globalForDb.__tomatoPgPool = undefined;
    await pool.end();
  }
}
