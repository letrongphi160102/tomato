import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { InMemoryMediaStorageAdapter } from '@/core/storage/in-memory-adapter';
import {
  AVATAR_FILE_NAME_REGEX,
  AVATAR_STORAGE_KEY_REGEX,
  CHAT_MEDIA_FILE_NAME_REGEX,
  CHAT_MEDIA_STORAGE_KEY_REGEX,
  LocalFsStorageAdapter,
  extractAvatarFileNameFromKey,
  generateChatMediaStorageKey,
  isValidAvatarFileName,
  isValidAvatarStorageKey,
  isValidChatMediaStorageKey,
  isValidManagedStorageKey,
} from '@/core/storage/local-fs-adapter';
import type {
  CreateEncryptedUploadGrantInput,
  EncryptedUploadGrant,
  MediaStorageProvider,
  MediaStorageProviderType,
  PutMediaObjectInput,
  ReadMediaObjectResult,
  StoredMediaObject,
  VerifyUploadedObjectResult,
} from '@/core/storage/types';
import { VercelBlobStorageAdapter } from '@/core/storage/vercel-blob-adapter';

export {
  AVATAR_FILE_NAME_REGEX,
  AVATAR_STORAGE_KEY_REGEX,
  CHAT_MEDIA_FILE_NAME_REGEX,
  CHAT_MEDIA_STORAGE_KEY_REGEX,
  InMemoryMediaStorageAdapter,
  LocalFsStorageAdapter,
  VercelBlobStorageAdapter,
  extractAvatarFileNameFromKey,
  generateChatMediaStorageKey,
  isValidAvatarFileName,
  isValidAvatarStorageKey,
  isValidChatMediaStorageKey,
  isValidManagedStorageKey,
};
export type {
  CreateEncryptedUploadGrantInput,
  EncryptedUploadGrant,
  MediaStorageProvider,
  MediaStorageProviderType,
  PutMediaObjectInput,
  ReadMediaObjectResult,
  StoredMediaObject,
  VerifyUploadedObjectResult,
};

type StorageEnvConfig = Pick<
  Env,
  'STORAGE_PROVIDER' | 'LOCAL_STORAGE_DIR' | 'BLOB_READ_WRITE_TOKEN'
>;

export function createMediaStorageProvider(config: StorageEnvConfig): MediaStorageProvider {
  if (config.STORAGE_PROVIDER === 'vercel_blob') {
    if (!config.BLOB_READ_WRITE_TOKEN) {
      throw new Error('Thiếu BLOB_READ_WRITE_TOKEN khi STORAGE_PROVIDER=vercel_blob');
    }
    return new VercelBlobStorageAdapter({ token: config.BLOB_READ_WRITE_TOKEN });
  }

  return new LocalFsStorageAdapter(config.LOCAL_STORAGE_DIR);
}

const globalForStorage = globalThis as typeof globalThis & {
  __tomatoMediaStorageProvider?: MediaStorageProvider;
};

export function getMediaStorageProvider(): MediaStorageProvider {
  if (!globalForStorage.__tomatoMediaStorageProvider) {
    globalForStorage.__tomatoMediaStorageProvider = createMediaStorageProvider(getEnv());
  }
  return globalForStorage.__tomatoMediaStorageProvider;
}

export function setMediaStorageProviderForTesting(provider: MediaStorageProvider): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setMediaStorageProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForStorage.__tomatoMediaStorageProvider = provider;
}

export function resetMediaStorageProviderForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetMediaStorageProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForStorage.__tomatoMediaStorageProvider = undefined;
}
