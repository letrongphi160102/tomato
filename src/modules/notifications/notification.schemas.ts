import { z } from 'zod';

import { NOTIFICATION_MESSAGES } from '@/modules/notifications/notification.messages';
import {
  PUBLIC_ID_UUID_V4_REGEX,
  decodeSocialCursor,
  encodeSocialCursor,
  type SocialKeysetCursor,
} from '@/modules/social/social.schemas';

export const NOTIFICATION_LIST_DEFAULT_LIMIT = 20;
export const NOTIFICATION_LIST_MAX_LIMIT = 30;
export const NOTIFICATION_MARK_READ_MAX_BATCH = 50;

export type NotificationKeysetCursor = SocialKeysetCursor;

export const encodeNotificationCursor = encodeSocialCursor;
export const decodeNotificationCursor = decodeSocialCursor;

const notificationLimitSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === '') {
      return NOTIFICATION_LIST_DEFAULT_LIMIT;
    }
    return typeof val === 'number' ? val : Number(val);
  })
  .refine((val) => Number.isInteger(val) && val >= 1 && val <= NOTIFICATION_LIST_MAX_LIMIT, {
    message: NOTIFICATION_MESSAGES.invalidLimit,
  });

const notificationCursorSchema = z
  .string()
  .optional()
  .transform((val, ctx): NotificationKeysetCursor | undefined => {
    if (val === undefined || val === '') {
      return undefined;
    }
    const decoded = decodeNotificationCursor(val);
    if (!decoded) {
      ctx.addIssue({
        code: 'custom',
        message: NOTIFICATION_MESSAGES.invalidCursor,
      });
      return z.NEVER;
    }
    return decoded;
  });

/**
 * Schema query `GET /api/v1/notifications?cursor=&limit=` (`.strict()` từ chối tham số lạ).
 */
export const notificationListQuerySchema = z
  .object({
    cursor: notificationCursorSchema,
    limit: notificationLimitSchema,
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

const notificationPublicIdSchema = z
  .string()
  .trim()
  .regex(PUBLIC_ID_UUID_V4_REGEX, { message: NOTIFICATION_MESSAGES.validationFailed })
  .transform((value) => value.toLowerCase());

/**
 * Schema kiểm tra tham số đường dẫn `:notificationPublicId` (bắt buộc UUIDv4 công khai).
 */
export const notificationPublicIdParamSchema = notificationPublicIdSchema;

/**
 * Schema query cho `DELETE /api/v1/notifications/:notificationPublicId` (`.strict()` từ chối tham số lạ như `userId`).
 */
export const deleteNotificationQuerySchema = z.object({}).strict();

/**
 * Schema body `POST /api/v1/notifications/read` (`.strict()` từ chối field lạ):
 * chỉ chấp nhận ĐÚNG 1 trong 2 dạng: `{ markAll: true }` hoặc `{ notificationPublicIds: UUIDv4[] }`.
 */
export const markNotificationsReadInputSchema = z
  .object({
    markAll: z.literal(true).optional(),
    notificationPublicIds: z
      .array(notificationPublicIdSchema)
      .min(1, { message: NOTIFICATION_MESSAGES.invalidReadPayload })
      .max(NOTIFICATION_MARK_READ_MAX_BATCH, {
        message: NOTIFICATION_MESSAGES.validationFailed,
      })
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasMarkAll = data.markAll === true;
    const hasIds =
      Array.isArray(data.notificationPublicIds) && data.notificationPublicIds.length > 0;
    if (hasMarkAll === hasIds) {
      ctx.addIssue({
        code: 'custom',
        path: hasMarkAll ? ['notificationPublicIds'] : ['markAll'],
        message: NOTIFICATION_MESSAGES.invalidReadPayload,
      });
    }
  });

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>;
