import 'server-only';

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  MediaStorageProvider,
  PutMediaObjectInput,
  ReadMediaObjectResult,
  StoredMediaObject,
} from '@/core/storage/types';

export const AVATAR_FILE_NAME_REGEX = /^[a-f0-9]{32}\.webp$/;
export const AVATAR_STORAGE_KEY_REGEX = /^avatars\/[a-f0-9]{32}\.webp$/;

export function isValidAvatarFileName(fileName: string): boolean {
  return AVATAR_FILE_NAME_REGEX.test(fileName);
}

export function isValidAvatarStorageKey(storageKey: string): boolean {
  return AVATAR_STORAGE_KEY_REGEX.test(storageKey);
}

export function extractAvatarFileNameFromKey(storageKey: string): string | null {
  if (!isValidAvatarStorageKey(storageKey)) {
    return null;
  }
  return storageKey.slice('avatars/'.length);
}

export class LocalFsStorageAdapter implements MediaStorageProvider {
  public readonly provider = 'local' as const;
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolveSafePath(storageKey: string): string {
    if (!isValidAvatarStorageKey(storageKey)) {
      throw new Error('Khóa lưu trữ media không hợp lệ');
    }

    const resolved = path.resolve(this.rootDir, storageKey);
    const rootWithSep = this.rootDir.endsWith(path.sep)
      ? this.rootDir
      : `${this.rootDir}${path.sep}`;

    if (!resolved.startsWith(rootWithSep)) {
      throw new Error('Phát hiện đường dẫn lưu trữ nằm ngoài thư mục cho phép');
    }

    return resolved;
  }

  async putObject(input: PutMediaObjectInput): Promise<StoredMediaObject> {
    const fileName = extractAvatarFileNameFromKey(input.storageKey);
    if (!fileName) {
      throw new Error('Khóa lưu trữ ảnh đại diện không hợp lệ');
    }

    const targetPath = this.resolveSafePath(input.storageKey);
    const parentDir = path.dirname(targetPath);
    await mkdir(parentDir, { recursive: true });

    // Ghi file tạm rồi rename nguyên tử để không bao giờ phục vụ ảnh bị ghi dở.
    const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, input.body);
      await rename(tmpPath, targetPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      storageKey: input.storageKey,
      url: `/api/v1/media/local/avatars/${fileName}`,
      byteLength: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  async readObject(storageKey: string): Promise<ReadMediaObjectResult | null> {
    if (!isValidAvatarStorageKey(storageKey)) {
      return null;
    }

    const targetPath = this.resolveSafePath(storageKey);
    try {
      const body = await readFile(targetPath);
      return {
        body,
        contentType: 'image/webp',
      };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(storageKey: string): Promise<void> {
    if (!isValidAvatarStorageKey(storageKey)) {
      return;
    }

    const targetPath = this.resolveSafePath(storageKey);
    await rm(targetPath, { force: true });
  }
}
