import 'server-only';

import {
  extractAvatarFileNameFromKey,
  isValidChatMediaStorageKey,
  isValidManagedStorageKey,
} from '@/core/storage/local-fs-adapter';
import type {
  CreateEncryptedUploadGrantInput,
  EncryptedUploadGrant,
  MediaStorageProvider,
  PutMediaObjectInput,
  ReadMediaObjectResult,
  StoredMediaObject,
  VerifyUploadedObjectResult,
} from '@/core/storage/types';

interface StoredEntry {
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * Adapter lưu trữ trong bộ nhớ (RAM) dành riêng cho Unit/Security/Integration Tests.
 * Giúp toàn bộ bộ test CI chạy 100% offline không cần `BLOB_READ_WRITE_TOKEN` và không ghi rác ra ổ đĩa.
 */
export class InMemoryMediaStorageAdapter implements MediaStorageProvider {
  public readonly provider = 'memory' as const;
  private readonly store = new Map<string, StoredEntry>();
  public readonly deletedKeys: string[] = [];
  public failDeleteOnceWithError: Error | null = null;

  async putObject(input: PutMediaObjectInput): Promise<StoredMediaObject> {
    if (!isValidManagedStorageKey(input.storageKey)) {
      throw new Error('Khóa lưu trữ media không hợp lệ');
    }

    const copy = Buffer.from(input.body);
    this.store.set(input.storageKey, {
      body: copy,
      contentType: input.contentType,
    });

    const avatarFileName = extractAvatarFileNameFromKey(input.storageKey);
    return {
      storageKey: input.storageKey,
      url: avatarFileName ? `/api/v1/media/local/avatars/${avatarFileName}` : input.storageKey,
      byteLength: copy.byteLength,
      contentType: input.contentType,
    };
  }

  async readObject(storageKey: string): Promise<ReadMediaObjectResult | null> {
    if (!isValidManagedStorageKey(storageKey)) {
      return null;
    }
    const found = this.store.get(storageKey);
    if (!found) {
      return null;
    }
    return {
      body: Buffer.from(found.body),
      contentType: found.contentType,
    };
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
    const found = this.store.get(storageKey);
    if (!found || found.body.byteLength !== options.expectedSizeBytes) {
      return null;
    }
    return {
      exists: true,
      url: storageKey,
      byteLength: found.body.byteLength,
      contentType: found.contentType,
    };
  }

  async deleteObject(storageKey: string): Promise<void> {
    if (this.failDeleteOnceWithError) {
      const err = this.failDeleteOnceWithError;
      this.failDeleteOnceWithError = null;
      throw err;
    }
    this.deletedKeys.push(storageKey);
    this.store.delete(storageKey);
  }

  has(storageKey: string): boolean {
    return this.store.has(storageKey);
  }

  clear(): void {
    this.store.clear();
    this.deletedKeys.length = 0;
  }
}
