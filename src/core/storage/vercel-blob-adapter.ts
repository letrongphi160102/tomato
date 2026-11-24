import 'server-only';

import { BlobNotFoundError, del, head, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

import {
  isValidAvatarStorageKey,
  isValidChatMediaStorageKey,
  isValidManagedStorageKey,
} from '@/core/storage/local-fs-adapter';
import type {
  CreateEncryptedUploadGrantInput,
  EncryptedUploadGrant,
  MediaStorageProvider,
  PutMediaObjectInput,
  StoredMediaObject,
  VerifyUploadedObjectResult,
} from '@/core/storage/types';

const VERCEL_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';
const IMMUTABLE_BLOB_CACHE_MAX_AGE_SECONDS = 31_536_000; // 1 năm (tên file CSPRNG bất biến)

function parseStoreIdFromReadWriteToken(token: string): string | null {
  const parts = token.split('_');
  const candidate = parts[3]?.trim() ?? '';
  if (!candidate || !/^[a-z0-9-]+$/i.test(candidate)) {
    return null;
  }
  return candidate;
}

function buildAuthoritativePublicBlobUrl(token: string, pathname: string): string {
  const storeId = parseStoreIdFromReadWriteToken(token);
  if (!storeId) {
    return pathname;
  }
  return `https://${storeId}.public.blob.vercel-storage.com/${pathname}`;
}

function isDeletableVercelBlobTarget(storageKey: string): boolean {
  if (isValidManagedStorageKey(storageKey)) {
    return true;
  }

  try {
    const parsed = new URL(storageKey);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase().endsWith(VERCEL_BLOB_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

export interface VercelBlobStorageAdapterOptions {
  readonly token: string;
}

/**
 * Adapter lưu trữ Media trên Vercel Blob (Hobby Free, 0đ).
 * Phục vụ file trên domain tách biệt `*.public.blob.vercel-storage.com` không gửi kèm cookie phiên TOMATO.
 * Đối chiếu trực tiếp `@vercel/blob@2.9.0`:
 * - Ảnh đại diện (server-side): `put(pathname, body, { access: 'public', addRandomSuffix: false, ... })`
 * - Bản mã Chat E2EE (client upload vượt trần 4.5MB Serverless):
 *   + Cấp token ngắn hạn bằng `generateClientTokenFromReadWriteToken` khóa cứng `pathname`,
 *     `allowedContentTypes: ['application/octet-stream']`, `maximumSizeInBytes: exactSizeBytes`.
 *   + Xác minh bản mã đã lên store bằng `head(expectedFullUrl, { token })` (dựng URL uy tín từ `storeId` của token).
 *   + Xóa vĩnh viễn khi thu hồi bằng `del(urlOrPathname, { token })`.
 */
export class VercelBlobStorageAdapter implements MediaStorageProvider {
  public readonly provider = 'vercel_blob' as const;
  private readonly token: string;

  constructor(options: VercelBlobStorageAdapterOptions) {
    if (!options.token.trim()) {
      throw new Error('Thiếu BLOB_READ_WRITE_TOKEN cho VercelBlobStorageAdapter');
    }
    this.token = options.token;
  }

  async putObject(input: PutMediaObjectInput): Promise<StoredMediaObject> {
    if (
      !isValidAvatarStorageKey(input.storageKey) &&
      !isValidChatMediaStorageKey(input.storageKey)
    ) {
      throw new Error('Khóa lưu trữ media không hợp lệ');
    }

    const blob = await put(input.storageKey, input.body, {
      access: 'public',
      addRandomSuffix: false,
      contentType: input.contentType,
      cacheControlMaxAge: IMMUTABLE_BLOB_CACHE_MAX_AGE_SECONDS,
      token: this.token,
    });

    return {
      // Lưu nguyên `blob.url` làm storageKey nội bộ để `del(url, { token })` xóa chính xác đối tượng trên store.
      storageKey: blob.url,
      url: blob.url,
      byteLength: input.body.byteLength,
      contentType: blob.contentType || input.contentType,
    };
  }

  async createEncryptedUploadGrant(
    input: CreateEncryptedUploadGrantInput,
  ): Promise<EncryptedUploadGrant> {
    if (!isValidChatMediaStorageKey(input.storageKey)) {
      throw new Error('Khóa lưu trữ tệp đính kèm không hợp lệ');
    }

    // Khóa chặt đúng kích thước bản mã đã kiểm định (exactSizeBytes) & chỉ nhận application/octet-stream.
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: this.token,
      pathname: input.storageKey,
      allowedContentTypes: ['application/octet-stream'],
      maximumSizeInBytes: input.exactSizeBytes,
      validUntil: input.expiresAt.getTime(),
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: IMMUTABLE_BLOB_CACHE_MAX_AGE_SECONDS,
    });

    return {
      uploadMode: 'vercel_blob',
      pathname: input.storageKey,
      clientToken,
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

    const authoritativeTarget = buildAuthoritativePublicBlobUrl(this.token, storageKey);
    try {
      const metadata = await head(authoritativeTarget, { token: this.token });
      if (
        metadata.pathname !== storageKey ||
        metadata.size !== options.expectedSizeBytes ||
        metadata.contentType !== 'application/octet-stream'
      ) {
        return null;
      }

      return {
        exists: true,
        url: metadata.url,
        byteLength: metadata.size,
        contentType: metadata.contentType,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(storageKey: string): Promise<void> {
    if (!storageKey || !isDeletableVercelBlobTarget(storageKey)) {
      return;
    }

    const target = isValidChatMediaStorageKey(storageKey)
      ? buildAuthoritativePublicBlobUrl(this.token, storageKey)
      : storageKey;

    try {
      await del(target, { token: this.token });
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return;
      }
      throw error;
    }
  }
}
