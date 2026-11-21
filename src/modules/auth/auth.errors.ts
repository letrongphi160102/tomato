import type { ApiErrorCode, ApiErrorDetail } from '@/core/security/http-response';

export interface AuthDomainErrorOptions {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/**
 * Lỗi nghiệp vụ có kiểm soát từ tầng `AuthService` để Route Handler ánh xạ trực tiếp sang
 * HTTP status + JSON Error Contract chuẩn mà không làm lộ lỗi nội bộ.
 */
export class AuthDomainError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details: readonly ApiErrorDetail[];
  public readonly retryAfterSeconds?: number;

  constructor(options: AuthDomainErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AuthDomainError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
