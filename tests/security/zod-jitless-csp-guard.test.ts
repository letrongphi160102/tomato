import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = join(process.cwd(), 'src');
const ZOD_SETUP_IMPORT = "import '@/core/validation/zod-config';";
const ZOD_VALUE_IMPORT_REGEX = /^import\s+\{[^}]*\bz\b[^}]*\}\s+from\s+'zod';$/m;

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Security: Zod jitless chống vi phạm CSP unsafe-eval trên trình duyệt', () => {
  it('cấu hình Zod toàn cục bật jitless sau khi nạp schema (không dò thử new Function)', async () => {
    await import('@/modules/auth/auth.schemas');
    const { config } = await import('zod');
    expect(config().jitless).toBe(true);
  });

  it('mọi file khai báo schema bằng `z` đều import zod-config TRƯỚC khi import zod', () => {
    const offenders: string[] = [];

    for (const filePath of collectSourceFiles(SRC_DIR)) {
      const source = readFileSync(filePath, 'utf8');
      const zodImportMatch = ZOD_VALUE_IMPORT_REGEX.exec(source);
      if (!zodImportMatch) {
        continue;
      }
      const setupIndex = source.indexOf(ZOD_SETUP_IMPORT);
      if (setupIndex === -1 || setupIndex > zodImportMatch.index) {
        offenders.push(relative(process.cwd(), filePath));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('client bootstrap nạp zod-config sớm nhất có thể', () => {
    const clientBootstrap = readFileSync(join(SRC_DIR, 'instrumentation-client.ts'), 'utf8');
    expect(clientBootstrap.startsWith(ZOD_SETUP_IMPORT)).toBe(true);
  });
});
