export interface E2eePublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly ext?: boolean;
  key_ops?: string[];
}

export interface E2eePrivateJwk extends E2eePublicJwk {
  d: string;
}

export interface E2eeDeviceKeyPairMaterial {
  readonly userPublicId: string;
  readonly devicePublicId: string;
  readonly keyFingerprint: string;
  readonly identityPrivateKey: CryptoKey;
  readonly identityPublicKeyJwk: E2eePublicJwk;
  readonly signingPrivateKey: CryptoKey;
  readonly signingPublicKeyJwk: E2eePublicJwk;
  readonly createdAtIso: string;
  readonly isBackupKey?: boolean;
}

export interface E2eeTargetDevicePublicKey {
  readonly devicePublicId: string;
  readonly keyFingerprint: string;
  readonly isSyncKey?: boolean;
  readonly identityPublicKeyJwk: E2eePublicJwk;
  readonly signingPublicKeyJwk: E2eePublicJwk;
}

export interface WrappedMessageKeyPayload {
  readonly ephemeralPublicKeyJwk: E2eePublicJwk;
  readonly iv: string;
  readonly wrappedKey: string;
}

export interface MessageCryptoHeader {
  readonly v: 1;
  readonly alg: 'ECDH-P256-HKDF-AES256GCM';
  readonly iv: string;
  readonly senderDevicePublicId: string;
  readonly senderKeyFingerprint: string;
  readonly senderSigningPublicKeyJwk: E2eePublicJwk;
  readonly signature: string;
  readonly ratchetStep?: number;
  readonly wrappedKeys: Readonly<Record<string, WrappedMessageKeyPayload>>;
}

export interface EncryptedDirectMessageEnvelope {
  readonly ciphertext: string;
  readonly cryptoHeader: MessageCryptoHeader;
}

export type DecryptedMediaKind = 'image' | 'voice';

export interface DecryptedMessageMediaPayload {
  readonly kind: DecryptedMediaKind;
  readonly attachmentPublicId: string;
  readonly fileKey: string;
  readonly fileIv: string;
  readonly ciphertextSha256: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly waveform?: readonly number[];
  readonly thumbnailDataUrl?: string;
}

export interface DecryptedDirectMessagePayload {
  readonly v: 1;
  readonly text: string;
  readonly sentAt: string;
  readonly media?: DecryptedMessageMediaPayload;
}

export type E2eeErrorCode =
  | 'WEBCRYPTO_UNAVAILABLE'
  | 'INVALID_KEY_FORMAT'
  | 'INVALID_PIN_FORMAT'
  | 'NO_RECIPIENT_KEYS'
  | 'MISSING_WRAPPED_KEY'
  | 'INVALID_SIGNATURE'
  | 'UNTRUSTED_SIGNING_KEY'
  | 'AAD_OR_CIPHERTEXT_TAMPERED'
  | 'BACKUP_DECRYPT_FAILED'
  | 'MEDIA_INVALID_TYPE'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_INTEGRITY_MISMATCH'
  | 'MEDIA_DECRYPT_FAILED';

export class E2eeCryptoError extends Error {
  public readonly code: E2eeErrorCode;

  constructor(code: E2eeErrorCode, message: string) {
    super(message);
    this.name = 'E2eeCryptoError';
    this.code = code;
  }
}
