import 'server-only';

import { isIP } from 'node:net';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type DbExecutor } from '@/core/db';
import { auditLogs } from '@/core/db/schema/audit-logs';

export const AUDIT_ACTIONS = [
  'REGISTER',
  'EMAIL_VERIFIED',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'ACCOUNT_LOCKED',
  'SESSION_REVOKED',
  'TOKEN_REUSE_DETECTED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogInput {
  readonly userId?: string | null;
  readonly action: AuditAction;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Record<string, unknown>;
}

// Danh sách mẫu tên trường nhạy cảm tuyệt đối không được phép ghi vào bảng audit_logs.
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|token|otp|ticket|secret|pepper|cookie|authorization|csrf|hash|private[_-]?key|api[_-]?key|credential)/i;

// Phòng thủ chiều sâu: ngăn chuỗi giống JWT, header Bearer, hash Argon2, cookie phiên hoặc URL chứa token/OTP
// vô tình lọt vào giá trị metadata ngay cả khi nằm giữa chuỗi tự do hoặc gán dưới tên khóa thông thường.
const SENSITIVE_VALUE_PATTERN =
  /(\bBearer\s+\S+)|(\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)|(\$argon2(?:id|i|d)\$)|((?:__Host-)?tomato_(?:at|rt|csrf|pwd_ticket)=)|([?&](?:token|reset_token|access_token|refresh_token|otp|otpCode|otp_code|code|password|ticket)=[^&\s]+)/i;

const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 1024;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value.trim())) {
      return '[REDACTED]';
    }
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...`
      : value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (depth >= MAX_METADATA_DEPTH) {
    return '[TRUNCATED]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const cleanObject: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    let count = 0;

    for (const [key, nestedValue] of entries) {
      if (count >= MAX_METADATA_KEYS) {
        break;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      if (nestedValue === undefined) {
        continue;
      }
      cleanObject[key] = sanitizeValue(nestedValue, depth + 1);
      count += 1;
    }

    return cleanObject;
  }

  return null;
}

/**
 * Vệ sinh đối tượng `metadata` trước khi lưu JSONB, đảm bảo loại bỏ hoàn toàn
 * mọi trường chứa mật khẩu, OTP, token, cookie, secret hoặc JWT thô.
 */
export function sanitizeAuditMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  const sanitized = sanitizeValue(metadata, 0);
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return {};
}

/**
 * Chuẩn hóa địa chỉ IP cho cột PostgreSQL `INET`.
 * Nếu IP không hợp lệ (ví dụ header bị giả mạo), trả `null` thay vì để PostgreSQL ném lỗi làm mất audit log.
 */
export function normalizeIpAddress(rawIp?: string | null): string | null {
  if (!rawIp) {
    return null;
  }

  const firstSegment = rawIp.split(',')[0]?.trim();
  if (!firstSegment) {
    return null;
  }

  // Gỡ dấu ngoặc vuông bao quanh IPv6 (ví dụ `[::1]`) nếu có.
  const unwrapped =
    firstSegment.startsWith('[') && firstSegment.endsWith(']')
      ? firstSegment.slice(1, -1)
      : firstSegment;

  return isIP(unwrapped) !== 0 ? unwrapped : null;
}

function normalizeUserAgent(rawUserAgent?: string | null): string | null {
  if (!rawUserAgent) {
    return null;
  }
  const trimmed = rawUserAgent.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > MAX_USER_AGENT_LENGTH ? trimmed.slice(0, MAX_USER_AGENT_LENGTH) : trimmed;
}

export class AuditLogService {
  private readonly getDefaultDb: () => DbExecutor;

  constructor(getDefaultDb: () => DbExecutor = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  /**
   * Ghi 1 bản ghi sự kiện bảo mật vào bảng `audit_logs`.
   * Chấp nhận tùy chọn `tx` để ghi nguyên tử trong cùng transaction với nghiệp vụ Auth.
   */
  async record(input: AuditLogInput, tx?: DbExecutor): Promise<{ readonly id: string }> {
    const executor = tx ?? this.getDefaultDb();
    const id = generateUuidV7();

    await executor.insert(auditLogs).values({
      id,
      userId: input.userId ?? null,
      action: input.action,
      ipAddress: normalizeIpAddress(input.ipAddress),
      userAgent: normalizeUserAgent(input.userAgent),
      metadata: sanitizeAuditMetadata(input.metadata),
    });

    return { id };
  }
}

const globalForAudit = globalThis as typeof globalThis & {
  __tomatoAuditLogService?: AuditLogService;
};

export function getAuditLogService(): AuditLogService {
  if (!globalForAudit.__tomatoAuditLogService) {
    globalForAudit.__tomatoAuditLogService = new AuditLogService();
  }
  return globalForAudit.__tomatoAuditLogService;
}
