import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LocalFsStorageAdapter,
  isValidAvatarFileName,
  isValidAvatarStorageKey,
} from '@/core/storage';

describe('Unit M6: LocalFsStorageAdapter (an toàn đường dẫn & ghi nguyên tử)', () => {
  let tempDir: string;
  let adapter: LocalFsStorageAdapter;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tomato-m6-storage-'));
    adapter = new LocalFsStorageAdapter(tempDir);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lưu, đọc và xóa ảnh đại diện nguyên tử, idempotent khi xóa lặp lại', async () => {
    const key = 'avatars/0123456789abcdef0123456789abcdef.webp';
    const body = Buffer.from('RIFF\x00\x00\x00\x00WEBPfake-payload', 'binary');

    const stored = await adapter.putObject({
      storageKey: key,
      body,
      contentType: 'image/webp',
    });

    expect(stored).toEqual({
      storageKey: key,
      url: '/api/v1/media/local/avatars/0123456789abcdef0123456789abcdef.webp',
      byteLength: body.byteLength,
      contentType: 'image/webp',
    });

    const loaded = await adapter.readObject(key);
    expect(loaded).not.toBeNull();
    expect(loaded?.body.equals(body)).toBe(true);

    await adapter.deleteObject(key);
    expect(await adapter.readObject(key)).toBeNull();

    // Xóa lặp lại không được ném lỗi.
    await expect(adapter.deleteObject(key)).resolves.toBeUndefined();
  });

  it('chặn tuyệt đối Path Traversal và tên tệp ngoài chuẩn 32-hex .webp', async () => {
    const maliciousKeys = [
      '../secret.txt',
      'avatars/../../etc/passwd',
      'avatars/..\\..\\windows\\win.ini',
      'avatars/avatar.svg',
      'avatars/0123456789abcdef0123456789abcdef.png',
      'other/0123456789abcdef0123456789abcdef.webp',
    ];

    for (const badKey of maliciousKeys) {
      expect(isValidAvatarStorageKey(badKey)).toBe(false);
      await expect(
        adapter.putObject({
          storageKey: badKey,
          body: Buffer.from('x'),
          contentType: 'image/webp',
        }),
      ).rejects.toThrow();
      expect(await adapter.readObject(badKey)).toBeNull();
    }

    expect(isValidAvatarFileName('0123456789abcdef0123456789abcdef.webp')).toBe(true);
    expect(isValidAvatarFileName('../0123456789abcdef0123456789abcdef.webp')).toBe(false);
    expect(isValidAvatarFileName('avatar.svg')).toBe(false);
  });
});
