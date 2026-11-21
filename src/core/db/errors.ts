import 'server-only';

export const PG_ERROR_CODES = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
});

interface MaybeCodedError {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

/**
 * Trích xuất mã lỗi PostgreSQL (`SQLSTATE`) từ cả lỗi `pg.DatabaseError` gốc
 * lẫn lỗi bọc `DrizzleQueryError` (nơi mã lỗi thực sự nằm trong chuỗi `error.cause`).
 */
export function extractPostgresErrorCode(error: unknown): string | null {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as MaybeCodedError;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }

  return null;
}

export function extractPostgresConstraintName(error: unknown): string | null {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as MaybeCodedError;
    if (typeof candidate.constraint === 'string' && candidate.constraint.length > 0) {
      return candidate.constraint;
    }
    current = candidate.cause;
  }

  return null;
}

export function isPostgresUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (extractPostgresErrorCode(error) !== PG_ERROR_CODES.UNIQUE_VIOLATION) {
    return false;
  }
  if (!constraintName) {
    return true;
  }
  return extractPostgresConstraintName(error) === constraintName;
}
