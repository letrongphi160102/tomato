import 'server-only';

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CreateEncryptedUploadGrantInput,
  EncryptedUploadGrant,
  MediaStorageProvider,
  PutMediaObjectInput,
  ReadMediaObjectResult,
  StoredMediaObject,
  VerifyUploadedObjectResult,
} from '@/core/storage/types';

export const AVATAR_FILE_NAME_REGEX = /^[a-f0-9]{32}\.webp$/;
export const AVATAR_STORAGE_KEY_REGEX = /^avatars\/[a-f0-9]{32}\.webp$/;
export const CHAT_MEDIA_FILE_NAME_REGEX = /^[a-f0-9]{32}\.bin$/;
export const CHAT_MEDIA_STORAGE_KEY_REGEX = /^chat-media\/[a-f0-9]{32}\.bin$/;

export function isValidAvatarFileName(fileName: string): boolean {
  return AVATAR_FILE_NAME_REGEX.test(fileName);
}

export function isValidAvatarStorageKey(storageKey: string): boolean {
  return AVATAR_STORAGE_KEY_REGEX.test(storageKey);
}

export function isValidChatMediaStorageKey(storageKey: string): boolean {
  return CHAT_MEDIA_STORAGE_KEY_REGEX.test(storageKey);
}

export function isValidManagedStorageKey(storageKey: string): boolean {
  return isValidAvatarStorageKey(storageKey) || isValidChatMediaStorageKey(storageKey);
}

export function extractAvatarFileNameFromKey(storageKey: string): string | null {
  if (!isValidAvatarStorageKey(storageKey)) {
    return null;
  }
  return storageKey.slice('avatars/'.length);
}

export function generateChatMediaStorageKey(): string {
  return `chat-media/${randomBytes(16).toString('hex')}.bin`;
}

export class LocalFsStorageAdapter implements MediaStorageProvider {
  public readonly provider = 'local' as const;
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolveSafePath(storageKey: string): string {
    if (!isValidManagedStorageKey(storageKey)) {
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
    if (!isValidManagedStorageKey(input.storageKey)) {
      throw new Error('Khóa lưu trữ media không hợp lệ');
    }

    const targetPath = this.resolveSafePath(input.storageKey);
    const parentDir = path.dirname(targetPath);
    await mkdir(parentDir, { recursive: true });

    // Ghi file tạm rồi rename nguyên tử để không bao giờ phục vụ tệp bị ghi dở.
    const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, input.body);
      await rename(tmpPath, targetPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const avatarFileName = extractAvatarFileNameFromKey(input.storageKey);
    const url = avatarFileName ? `/api/v1/media/local/avatars/${avatarFileName}` : input.storageKey;

    return {
      storageKey: input.storageKey,
      url,
      byteLength: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  async readObject(storageKey: string): Promise<ReadMediaObjectResult | null> {
    if (!isValidManagedStorageKey(storageKey)) {
      return null;
    }

    const targetPath = this.resolveSafePath(storageKey);
    try {
      const body = await readFile(targetPath);
      return {
        body,
        contentType: isValidAvatarStorageKey(storageKey)
          ? 'image/webp'
          : 'application/octet-stream',
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

  async createEncryptedUploadGrant(
    input: CreateEncryptedUploadGrantInput,
  ): Promise<EncryptedUploadGrant> {
    if (!isValidChatMediaStorageKey(input.storageKey)) {
      throw new Error('Khóa lưu trữ tệp đính kèm không hợp lệ');
    }

    return {
      uploadMode: 'direct',
      pathname: input.storageKey,
      uploadUrl: `/api/v1/media/local/chat/${encodeURIComponent(input.attachmentPublicId)}`,
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  async verifyUploadedObject(
    storageKey: string,
    options: { readonly expectedSizeBytes: number },
  ): Promise<VerifyUploadedObjectResult | null> {
    if (!isValidChatMediaStorageKey(storageKey)) {
      return null;
    }

    const targetPath = this.resolveSafePath(storageKey);
    try {
      const info = await stat(targetPath);
      if (!info.isFile() || info.size !== options.expectedSizeBytes) {
        return null;
      }
      return {
        exists: true,
        url: storageKey,
        byteLength: info.size,
        contentType: 'application/octet-stream',
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
    if (!isValidManagedStorageKey(storageKey)) {
      return;
    }

    const targetPath = this.resolveSafePath(storageKey);
    await rm(targetPath, { force: true });
  }
}
