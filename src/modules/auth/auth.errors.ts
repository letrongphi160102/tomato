import type { ApiErrorCode, ApiErrorDetail } from '@/core/security/http-response';

export interface AuthDomainErrorOptions {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
  /** Khi `true`, Route Handler bắt buộc xóa toàn bộ cookie phiên (ví dụ khi phát hiện Token Reuse). */
  readonly clearCookies?: boolean;
  readonly cause?: unknown;
}

/**
 * Lỗi nghiệp vụ có kiểm soát từ tầng `AuthService` / `SessionService` để Route Handler ánh xạ
 * trực tiếp sang HTTP status + JSON Error Contract chuẩn mà không làm lộ lỗi nội bộ.
 */
export class AuthDomainError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details: readonly ApiErrorDetail[];
  public readonly retryAfterSeconds?: number;
  public readonly clearCookies: boolean;

  constructor(options: AuthDomainErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AuthDomainError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.clearCookies = options.clearCookies ?? false;
  }
}
