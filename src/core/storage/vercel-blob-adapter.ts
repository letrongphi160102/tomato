import 'server-only';

import { BlobNotFoundError, del, put } from '@vercel/blob';

import { isValidAvatarStorageKey } from '@/core/storage/local-fs-adapter';
import type {
  MediaStorageProvider,
  PutMediaObjectInput,
  StoredMediaObject,
} from '@/core/storage/types';

const VERCEL_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';
const AVATAR_CACHE_MAX_AGE_SECONDS = 31_536_000; // 1 năm (tên file CSPRNG bất biến)

function isDeletableVercelBlobTarget(storageKey: string): boolean {
  if (isValidAvatarStorageKey(storageKey)) {
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
 * Adapter lưu trữ ảnh đại diện trên Vercel Blob (Hobby Free, 0đ).
 * Phục vụ ảnh trên domain tách biệt `*.public.blob.vercel-storage.com` không gửi kèm cookie phiên TOMATO.
 * Đối chiếu API `@vercel/blob@2.9.0`:
 * - `put(pathname, body, { access: 'public', addRandomSuffix: false, contentType, cacheControlMaxAge, token })`
 * - `del(urlOrPathname, { token })`
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
    if (!isValidAvatarStorageKey(input.storageKey)) {
      throw new Error('Khóa lưu trữ ảnh đại diện không hợp lệ');
    }

    const blob = await put(input.storageKey, input.body, {
      access: 'public',
      addRandomSuffix: false,
      contentType: input.contentType,
      cacheControlMaxAge: AVATAR_CACHE_MAX_AGE_SECONDS,
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

  async deleteObject(storageKey: string): Promise<void> {
    if (!storageKey || !isDeletableVercelBlobTarget(storageKey)) {
      return;
    }

    try {
      await del(storageKey, { token: this.token });
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return;
      }
      throw error;
    }
  }
}
