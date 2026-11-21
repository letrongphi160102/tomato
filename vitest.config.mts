import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Next.js dùng điều kiện export `react-server` cho `server-only`.
      // Trong Vitest (Node runtime thuần), map sang stub rỗng để test trực tiếp server modules
      // trong khi vẫn giữ nguyên lớp bảo vệ thật của `server-only` khi build Next.js.
      'server-only': path.resolve(rootDir, 'tests/setup/server-only-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
