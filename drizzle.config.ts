import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

import { normalizePostgresConnectionString } from './src/core/db/connection-string';

// Tận dụng API native của Node 24 để nạp .env.local khi chạy CLI local
// mà không ghi đè biến môi trường đã được truyền sẵn từ CI/CD hoặc Production.
if (!process.env.DATABASE_URL && existsSync('.env.local')) {
  process.loadEnvFile('.env.local');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'Thiếu biến môi trường DATABASE_URL để chạy Drizzle Kit. Hãy kiểm tra .env.local hoặc biến môi trường hệ thống.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core/db/schema/index.ts',
  out: './src/core/db/migrations',
  dbCredentials: {
    url: normalizePostgresConnectionString(databaseUrl),
  },
  strict: true,
  verbose: true,
});
