import { PUBLIC_ID_UUID_V4_REGEX } from '@/modules/social/social.schemas';

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'id',
  'userid',
  'user_id',
  'actorid',
  'actor_id',
  'recipientid',
  'recipient_id',
  'sessionid',
  'session_id',
  'email',
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'refreshtoken',
  'cookie',
  'cookies',
  'secret',
  'apikey',
  'api_key',
  'avatarstoragekey',
  'avatar_storage_key',
  'dateofbirth',
  'date_of_birth',
  'ipaddress',
  'ip_address',
]);

const EMAIL_VALUE_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

/**
 * Chuẩn hóa `public_id` (UUIDv4 công khai) và dựng tên kênh cá nhân `user:{publicId}`.
 * Fail-closed: từ chối mọi định dạng không phải UUIDv4 (chặn UUIDv7 nội bộ, wildcard `*`, dấu `:`...).
 */
export function normalizeRealtimeUserPublicId(rawPublicId: string): string {
  const trimmed = rawPublicId.trim().toLowerCase();
  if (!PUBLIC_ID_UUID_V4_REGEX.test(trimmed)) {
    throw new Error('Định danh kênh Realtime không hợp lệ.');
  }
  return trimmed;
}

export function buildUserRealtimeChannel(userPublicId: string): string {
  return `user:${normalizeRealtimeUserPublicId(userPublicId)}`;
}

/**
 * Khóa quyền Ably tối thiểu (Principle of Least Privilege):
 * chỉ cấp duy nhất quyền `subscribe` trên chính xác 1 kênh `user:{publicId}`.
 */
export function buildSubscribeOnlyCapability(channel: string): string {
  if (!/^user:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(channel)) {
    throw new Error('Tên kênh Realtime không hợp lệ khi tạo capability.');
  }
  return JSON.stringify({ [channel]: ['subscribe'] });
}

function assertValueHasNoForbiddenFields(value: unknown, depth: number): void {
  if (value === null || value === undefined || depth > 8) {
    return;
  }
  if (typeof value === 'string') {
    if (EMAIL_VALUE_REGEX.test(value)) {
      throw new Error('Payload Realtime không được chứa địa chỉ email/PII.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertValueHasNoForbiddenFields(item, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
        throw new Error(`Payload Realtime chứa trường nhạy cảm bị cấm: ${key}`);
      }
      assertValueHasNoForbiddenFields(nested, depth + 1);
    }
  }
}

/**
 * Phòng thủ chiều sâu trước khi publish lên Ably/SSE:
 * chặn tuyệt đối việc vô tình đẩy khóa nội bộ `id` (UUIDv7), email, token hay PII ra kênh Realtime.
 */
export function assertRealtimePayloadSafe(payload: Record<string, unknown>): void {
  assertValueHasNoForbiddenFields(payload, 0);
}
