import 'server-only';

import '@/core/validation/zod-config';
import { z } from 'zod';

/** Thời hạn đổ chuông tối đa trước khi tự chuyển `missed` (45 giây). */
export const CALL_RING_TIMEOUT_MS = 45_000;
/** Ngưỡng dung sai tối thiểu khi phía callee gửi yêu cầu `timeout` (43 giây). */
export const CALL_CALLEE_TIMEOUT_MIN_ELAPSED_MS = 43_000;
/** Thời hạn mất tín hiệu duy trì kết nối (`heartbeat`) cho phiên `connected` trước khi auto-sweep (2 phút). */
export const CALL_HEARTBEAT_STALE_MS = 120_000;
/** Thời gian chờ chống spam gọi lại ngay sau khi bị từ chối (30 giây). */
export const CALL_DECLINE_COOLDOWN_SECONDS = 30;
/** Giới hạn tối đa kích thước SDP (32 KB — tương thích SDP đa codec Chrome/Safari mới). */
export const MAX_CALL_SDP_LENGTH = 32_768;
/** Giới hạn tối đa kích thước một gói ICE candidate (2 KB). */
export const MAX_CALL_ICE_CANDIDATE_LENGTH = 2_048;

// Chỉ chấp nhận UUIDv4 cho `public_id`, từ chối UUIDv7 nội bộ.
const PUBLIC_UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const callPublicIdParamSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(PUBLIC_UUID_V4_REGEX, 'Mã định danh cuộc gọi không hợp lệ.');

export const iceServersInputSchema = z.object({}).strict();

export const createCallInputSchema = z
  .object({
    conversationPublicId: callPublicIdParamSchema,
    callType: z.enum(['audio', 'video']),
  })
  .strict();

export const callOfferSignalSchema = z
  .object({
    type: z.literal('offer'),
    sdp: z
      .string()
      .min(1, 'Thiếu dữ liệu phiên kết nối.')
      .max(MAX_CALL_SDP_LENGTH, 'Dữ liệu phiên kết nối vượt quá kích thước cho phép.'),
  })
  .strict();

export const callAnswerSignalSchema = z
  .object({
    type: z.literal('answer'),
    sdp: z
      .string()
      .min(1, 'Thiếu dữ liệu phiên kết nối.')
      .max(MAX_CALL_SDP_LENGTH, 'Dữ liệu phiên kết nối vượt quá kích thước cho phép.'),
  })
  .strict();

export const callIceCandidateSignalSchema = z
  .object({
    type: z.literal('ice-candidate'),
    candidate: z
      .string()
      .max(MAX_CALL_ICE_CANDIDATE_LENGTH, 'Dữ liệu định tuyến vượt quá kích thước cho phép.'),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export const callSignalInputSchema = z.discriminatedUnion('type', [
  callOfferSignalSchema,
  callAnswerSignalSchema,
  callIceCandidateSignalSchema,
]);

export const callActionInputSchema = z
  .object({
    action: z.enum(['accept', 'decline', 'end', 'timeout', 'heartbeat']),
  })
  .strict();

export type CreateCallInput = z.infer<typeof createCallInputSchema>;
export type CallSignalInput = z.infer<typeof callSignalInputSchema>;
export type CallActionInput = z.infer<typeof callActionInputSchema>;
