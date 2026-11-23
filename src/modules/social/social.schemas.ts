import '@/core/validation/zod-config';
import { z } from 'zod';

import { normalizeSearchQuery } from '@/modules/profile/handle';
import { SOCIAL_MESSAGES } from '@/modules/social/social.messages';

export const SOCIAL_LIST_DEFAULT_LIMIT = 20;
export const SOCIAL_LIST_MAX_LIMIT = 30;
export const SOCIAL_LIST_SEARCH_MAX_LENGTH = 50;
export const SOCIAL_CURSOR_MAX_LENGTH = 256;

export const PUBLIC_ID_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const ISO_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export interface SocialKeysetCursor {
  /** Chuỗi mốc thời gian UTC độ chính xác microsecond khớp tuyệt đối với PostgreSQL `timestamptz`. */
  readonly createdAtIso: string;
  /** `public_id` (UUIDv4 công khai) dùng làm tie-breaker, tuyệt đối không dùng `id` nội bộ UUIDv7. */
  readonly publicId: string;
}

const cursorPayloadSchema = z
  .object({
    t: z
      .string()
      .regex(ISO_UTC_TIMESTAMP_REGEX)
      .refine((value) => !Number.isNaN(Date.parse(value))),
    p: z.string().regex(PUBLIC_ID_UUID_V4_REGEX),
  })
  .strict();

export function encodeSocialCursor(cursor: SocialKeysetCursor): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.createdAtIso,
      p: cursor.publicId.toLowerCase(),
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeSocialCursor(rawCursor: string): SocialKeysetCursor | null {
  if (
    !rawCursor ||
    rawCursor.length > SOCIAL_CURSOR_MAX_LENGTH ||
    !BASE64URL_REGEX.test(rawCursor)
  ) {
    return null;
  }

  let parsedJson: unknown;
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    parsedJson = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  const parsed = cursorPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  return {
    createdAtIso: parsed.data.t,
    publicId: parsed.data.p.toLowerCase(),
  };
}

/**
 * Kiểm tra `userPublicId` trên đường dẫn API: bắt buộc đúng định dạng UUIDv4 công khai.
 */
export const publicIdRouteParamSchema = z
  .string()
  .trim()
  .regex(PUBLIC_ID_UUID_V4_REGEX, { message: SOCIAL_MESSAGES.notFound })
  .transform((value) => value.toLowerCase());

const limitQueryFieldSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === '') {
      return SOCIAL_LIST_DEFAULT_LIMIT;
    }
    return typeof val === 'number' ? val : Number(val);
  })
  .refine((val) => Number.isInteger(val) && val >= 1 && val <= SOCIAL_LIST_MAX_LIMIT, {
    message: SOCIAL_MESSAGES.invalidLimit,
  });

const cursorQueryFieldSchema = z
  .string()
  .optional()
  .transform((val, ctx): SocialKeysetCursor | undefined => {
    if (val === undefined || val === '') {
      return undefined;
    }
    const decoded = decodeSocialCursor(val);
    if (!decoded) {
      ctx.addIssue({
        code: 'custom',
        message: SOCIAL_MESSAGES.invalidCursor,
      });
      return z.NEVER;
    }
    return decoded;
  });

/**
 * Schema query cho danh sách Followers & Following (`?cursor=&limit=&q=`), từ chối tham số lạ (`.strict()`).
 */
export const socialConnectionListQuerySchema = z
  .object({
    cursor: cursorQueryFieldSchema,
    limit: limitQueryFieldSchema,
    q: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) {
          return undefined;
        }
        const normalized = normalizeSearchQuery(val);
        return normalized.length > 0 ? normalized : undefined;
      })
      .refine((val) => val === undefined || val.length <= SOCIAL_LIST_SEARCH_MAX_LENGTH, {
        message: SOCIAL_MESSAGES.searchQueryTooLong,
      }),
  })
  .strict();

export type SocialConnectionListQuery = z.infer<typeof socialConnectionListQuerySchema>;

/**
 * Schema query cho danh sách Yêu cầu theo dõi & Tài khoản đã chặn (`?cursor=&limit=`), từ chối tham số lạ (`.strict()`).
 */
export const socialSimpleListQuerySchema = z
  .object({
    cursor: cursorQueryFieldSchema,
    limit: limitQueryFieldSchema,
  })
  .strict();

export type SocialSimpleListQuery = z.infer<typeof socialSimpleListQuerySchema>;

/**
 * Schema cập nhật cài đặt Quyền riêng tư (`PATCH /api/v1/users/me/privacy`), từ chối field lạ (`.strict()`).
 * Hỗ trợ cập nhật riêng lẻ hoặc đồng thời `isPrivate`, `showActiveStatus` và `showReadReceipts`.
 */
export const updatePrivacyInputSchema = z
  .object({
    isPrivate: z.boolean({ error: SOCIAL_MESSAGES.validationFailed }).optional(),
    acceptPendingRequests: z.boolean({ error: SOCIAL_MESSAGES.validationFailed }).optional(),
    showActiveStatus: z.boolean({ error: SOCIAL_MESSAGES.validationFailed }).optional(),
    showReadReceipts: z.boolean({ error: SOCIAL_MESSAGES.validationFailed }).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.isPrivate === undefined &&
      data.showActiveStatus === undefined &&
      data.showReadReceipts === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['isPrivate'],
        message: SOCIAL_MESSAGES.validationFailed,
      });
    }
    if (data.acceptPendingRequests !== undefined && data.isPrivate === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptPendingRequests'],
        message: SOCIAL_MESSAGES.validationFailed,
      });
    }
  });

export type UpdatePrivacyInput = z.infer<typeof updatePrivacyInputSchema>;
