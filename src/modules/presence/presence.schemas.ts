import { z } from 'zod';

import { PRESENCE_MESSAGES } from '@/modules/presence/presence.messages';
import { PUBLIC_ID_UUID_V4_REGEX } from '@/modules/social/social.schemas';

export const PRESENCE_QUERY_MAX_IDS = 30;

const targetPublicIdSchema = z
  .string()
  .trim()
  .regex(PUBLIC_ID_UUID_V4_REGEX, { message: PRESENCE_MESSAGES.validationFailed })
  .transform((value) => value.toLowerCase());

/**
 * Schema body `POST /api/v1/presence/heartbeat`: chỉ chấp nhận rỗng hoặc `{}` (`.strict()`).
 */
export const presenceHeartbeatInputSchema = z.object({}).strict();

/**
 * Schema body `POST /api/v1/presence/query`: tối đa 30 `public_id` mỗi lần truy vấn (`.strict()`).
 */
export const presenceQueryInputSchema = z
  .object({
    userPublicIds: z
      .array(targetPublicIdSchema)
      .min(1, { message: PRESENCE_MESSAGES.validationFailed })
      .max(PRESENCE_QUERY_MAX_IDS, { message: PRESENCE_MESSAGES.validationFailed }),
  })
  .strict();

export type PresenceQueryInput = z.infer<typeof presenceQueryInputSchema>;
