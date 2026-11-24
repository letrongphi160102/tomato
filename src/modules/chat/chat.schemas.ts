import 'server-only';

import '@/core/validation/zod-config';
import { z } from 'zod';

export const MAX_ACTIVE_E2EE_DEVICES_PER_USER = 10;
export const MAX_WRAPPED_KEYS_PER_MESSAGE = 20;
export const MAX_MESSAGE_CIPHERTEXT_LENGTH = 32_768;
export const MAX_PENDING_MESSAGES_BEFORE_ACCEPT = 3;
export const MAX_MESSAGE_EDIT_COUNT = 5;
export const MESSAGE_EDIT_WINDOW_MS = 5 * 60 * 1000;
export const MESSAGE_RECALL_WINDOW_MS = 5 * 60 * 1000;
export const MIN_PIN_BACKUP_PBKDF2_ITERATIONS = 600_000;
export const MAX_PIN_BACKUP_PBKDF2_ITERATIONS = 2_000_000;

/** Giới hạn dung lượng bản mã đính kèm (ảnh HD <= 10 MB + 64B tag GCM; voice <= 5 MB + 64B tag GCM). */
export const MAX_IMAGE_CIPHERTEXT_BYTES = 10 * 1024 * 1024 + 64;
export const MAX_VOICE_CIPHERTEXT_BYTES = 5 * 1024 * 1024 + 64;
export const ATTACHMENT_UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
export const ATTACHMENT_ORPHAN_EXPIRY_MS = 60 * 60 * 1000;
export const ATTACHMENT_LAZY_GC_BATCH_LIMIT = 5;

// Chỉ chấp nhận UUIDv4 cho public_id; từ chối UUIDv7 nội bộ để chống nhầm lẫn khóa chính.
const PUBLIC_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const CLIENT_MSG_ID_REGEX = /^[A-Za-z0-9._:-]+$/;

export const chatPublicIdParamSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(PUBLIC_UUID_V4_REGEX, 'Định danh công khai không hợp lệ.');

export const p256PublicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().trim().min(40).max(64).regex(BASE64URL_REGEX, 'Tọa độ khóa x không hợp lệ.'),
    y: z.string().trim().min(40).max(64).regex(BASE64URL_REGEX, 'Tọa độ khóa y không hợp lệ.'),
    ext: z.boolean().optional(),
    key_ops: z.array(z.string().max(32)).max(4).optional(),
  })
  .strict();

export const registerE2eeDeviceInputSchema = z
  .object({
    identityPublicKeyJwk: p256PublicJwkSchema,
    signingPublicKeyJwk: p256PublicJwkSchema,
    keyFingerprint: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SHA256_HEX_REGEX, 'Key fingerprint không hợp lệ.')
      .optional(),
    deviceLabel: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const upsertE2eeBackupInputSchema = z
  .object({
    encryptedKeyBlob: z
      .string()
      .trim()
      .min(32)
      .max(16_384)
      .regex(BASE64URL_REGEX, 'Bản sao lưu mã hóa không hợp lệ.'),
    kdfSalt: z
      .string()
      .trim()
      .min(16)
      .max(64)
      .regex(BASE64URL_REGEX, 'Muối dẫn xuất khóa không hợp lệ.'),
    kdfParams: z
      .object({
        alg: z.literal('PBKDF2-SHA256'),
        iterations: z
          .number()
          .int()
          .min(MIN_PIN_BACKUP_PBKDF2_ITERATIONS)
          .max(MAX_PIN_BACKUP_PBKDF2_ITERATIONS),
      })
      .strict(),
    iv: z.string().trim().min(12).max(32).regex(BASE64URL_REGEX, 'Vector khởi tạo không hợp lệ.'),
    keyFingerprint: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SHA256_HEX_REGEX, 'Key fingerprint không hợp lệ.'),
    version: z.number().int().min(1).max(32_767).optional(),
    identityPublicKeyJwk: p256PublicJwkSchema.optional(),
    signingPublicKeyJwk: p256PublicJwkSchema.optional(),
    deviceLabel: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.identityPublicKeyJwk === undefined && data.signingPublicKeyJwk === undefined) ||
      (data.identityPublicKeyJwk !== undefined && data.signingPublicKeyJwk !== undefined),
    {
      message: 'Cần cung cấp đầy đủ cặp khóa công khai đồng bộ.',
      path: ['identityPublicKeyJwk'],
    },
  );

export const confirmPinResetInputSchema = z
  .object({
    otpCode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Mã xác nhận phải gồm đúng 6 chữ số.'),
    encryptedKeyBlob: z
      .string()
      .trim()
      .min(32)
      .max(16_384)
      .regex(BASE64URL_REGEX, 'Bản sao lưu mã hóa không hợp lệ.'),
    kdfSalt: z
      .string()
      .trim()
      .min(16)
      .max(64)
      .regex(BASE64URL_REGEX, 'Muối dẫn xuất khóa không hợp lệ.'),
    kdfParams: z
      .object({
        alg: z.literal('PBKDF2-SHA256'),
        iterations: z
          .number()
          .int()
          .min(MIN_PIN_BACKUP_PBKDF2_ITERATIONS)
          .max(MAX_PIN_BACKUP_PBKDF2_ITERATIONS),
      })
      .strict(),
    iv: z.string().trim().min(12).max(32).regex(BASE64URL_REGEX, 'Vector khởi tạo không hợp lệ.'),
    keyFingerprint: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SHA256_HEX_REGEX, 'Key fingerprint không hợp lệ.'),
    identityPublicKeyJwk: p256PublicJwkSchema,
    signingPublicKeyJwk: p256PublicJwkSchema,
    deviceLabel: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const createDirectConversationInputSchema = z
  .object({
    recipientPublicId: chatPublicIdParamSchema,
  })
  .strict();

export const listConversationsQuerySchema = z
  .object({
    tab: z.enum(['primary', 'pending']).default('primary'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.coerce.number().int().min(1).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (query) =>
      !(
        (query.beforeSeq !== undefined || query.cursor !== undefined) &&
        query.afterSeq !== undefined
      ),
    {
      message: 'Không được truyền đồng thời cả beforeSeq và afterSeq.',
      path: ['beforeSeq'],
    },
  );

export const markConversationReadInputSchema = z
  .object({
    lastReadSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const wrappedMessageKeyEntrySchema = z
  .object({
    ephemeralPublicKeyJwk: p256PublicJwkSchema,
    iv: z.string().trim().min(12).max(32).regex(BASE64URL_REGEX),
    wrappedKey: z.string().trim().min(32).max(256).regex(BASE64URL_REGEX),
  })
  .strict();

export const messageCryptoHeaderSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('ECDH-P256-HKDF-AES256GCM'),
    iv: z.string().trim().min(12).max(32).regex(BASE64URL_REGEX),
    senderDevicePublicId: chatPublicIdParamSchema,
    senderKeyFingerprint: z.string().trim().toLowerCase().regex(SHA256_HEX_REGEX),
    senderSigningPublicKeyJwk: p256PublicJwkSchema,
    signature: z.string().trim().min(64).max(256).regex(BASE64URL_REGEX),
    ratchetStep: z.number().int().min(0).max(1_000_000).optional(),
    wrappedKeys: z.record(z.string().regex(SHA256_HEX_REGEX), wrappedMessageKeyEntrySchema).refine(
      (record: Record<string, unknown>) => {
        const count = Object.keys(record).length;
        return count >= 1 && count <= MAX_WRAPPED_KEYS_PER_MESSAGE;
      },
      {
        message: `Danh sách khóa thiết bị phải có từ 1 đến ${MAX_WRAPPED_KEYS_PER_MESSAGE} phần tử.`,
      },
    ),
  })
  .strict();

export const createAttachmentUploadTokenInputSchema = z
  .object({
    mediaKind: z.enum(['image', 'voice']),
    ciphertextSizeBytes: z.number().int().positive(),
    ciphertextSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SHA256_HEX_REGEX, 'Mã kiểm tra toàn vẹn tệp không hợp lệ.'),
  })
  .strict();

export const attachmentDownloadQuerySchema = z
  .object({
    download: z.enum(['1']).optional(),
  })
  .strict();

export const sendMessageInputSchema = z
  .object({
    clientMsgId: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(CLIENT_MSG_ID_REGEX, 'clientMsgId không hợp lệ.'),
    messageType: z.enum(['text', 'image', 'voice', 'call_event']).default('text'),
    ciphertext: z
      .string()
      .trim()
      .min(16)
      .max(MAX_MESSAGE_CIPHERTEXT_LENGTH)
      .regex(BASE64URL_REGEX, 'Bản mã tin nhắn không hợp lệ.'),
    cryptoHeader: messageCryptoHeaderSchema,
    attachmentPublicId: chatPublicIdParamSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.messageType !== 'image' &&
      data.messageType !== 'voice' &&
      data.attachmentPublicId !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachmentPublicId'],
        message: 'Tin nhắn văn bản không được kèm mã tệp đính kèm.',
      });
    }
  });

export const editMessageInputSchema = z
  .object({
    ciphertext: z
      .string()
      .trim()
      .min(16)
      .max(MAX_MESSAGE_CIPHERTEXT_LENGTH)
      .regex(BASE64URL_REGEX, 'Bản mã tin nhắn không hợp lệ.'),
    cryptoHeader: messageCryptoHeaderSchema,
  })
  .strict();

export const emptyStrictObjectSchema = z.object({}).strict();
