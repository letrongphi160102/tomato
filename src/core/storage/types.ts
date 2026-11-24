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

export interface CreateEncryptedUploadGrantInput {
  readonly attachmentPublicId: string;
  readonly storageKey: string;
  readonly exactSizeBytes: number;
  readonly expiresAt: Date;
}

export interface EncryptedUploadGrant {
  readonly uploadMode: 'vercel_blob' | 'direct';
  readonly pathname: string;
  readonly clientToken?: string;
  readonly uploadUrl?: string;
  readonly expiresAt: string;
}

export interface VerifyUploadedObjectResult {
  readonly exists: boolean;
  readonly url: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface MediaStorageProvider {
  readonly provider: MediaStorageProviderType;
  putObject(input: PutMediaObjectInput): Promise<StoredMediaObject>;
  deleteObject(storageKey: string): Promise<void>;
  readObject?(storageKey: string): Promise<ReadMediaObjectResult | null>;
  createEncryptedUploadGrant?(
    input: CreateEncryptedUploadGrantInput,
  ): Promise<EncryptedUploadGrant>;
  verifyUploadedObject?(
    storageKey: string,
    options: { readonly expectedSizeBytes: number },
  ): Promise<VerifyUploadedObjectResult | null>;
}
