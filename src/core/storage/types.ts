export type MediaStorageProviderType = 'local' | 'vercel_blob' | 'memory';

export interface PutMediaObjectInput {
  readonly storageKey: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface StoredMediaObject {
  readonly storageKey: string;
  readonly url: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface ReadMediaObjectResult {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface MediaStorageProvider {
  readonly provider: MediaStorageProviderType;
  putObject(input: PutMediaObjectInput): Promise<StoredMediaObject>;
  deleteObject(storageKey: string): Promise<void>;
  readObject?(storageKey: string): Promise<ReadMediaObjectResult | null>;
}
