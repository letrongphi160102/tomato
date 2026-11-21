import { existsSync } from 'node:fs';
import path from 'node:path';

// Nạp `.env.local` cho các bài test tích hợp chạy local khi biến môi trường chưa được truyền từ CI.
// `process.loadEnvFile` của Node 24 KHÔNG ghi đè các biến đã tồn tại (như `NODE_ENV=test` của Vitest).
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (!process.env.DATABASE_URL && existsSync(envLocalPath)) {
  process.loadEnvFile(envLocalPath);
}
