import type { ApiErrorCode, ApiErrorDetail } from '@/core/security/http-response';

export interface SocialDomainErrorOptions {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
}

export class SocialDomainError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details: readonly ApiErrorDetail[];
  public readonly retryAfterSeconds?: number;

  constructor(options: SocialDomainErrorOptions) {
    super(options.message);
    this.name = 'SocialDomainError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
