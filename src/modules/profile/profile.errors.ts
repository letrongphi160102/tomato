import type { ApiErrorCode, ApiErrorDetail } from '@/core/security/http-response';

export interface ProfileDomainErrorOptions {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
}

export class ProfileDomainError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details: readonly ApiErrorDetail[];
  public readonly retryAfterSeconds?: number;

  constructor(options: ProfileDomainErrorOptions) {
    super(options.message);
    this.name = 'ProfileDomainError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
