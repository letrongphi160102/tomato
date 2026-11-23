import 'server-only';

import type { ApiErrorCode, ApiErrorDetail } from '@/core/security/http-response';

export interface ChatDomainErrorOptions {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
  readonly retryAfterSeconds?: number;
}

export class ChatDomainError extends Error {
  public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  public readonly code: ApiErrorCode;
  public readonly details?: readonly ApiErrorDetail[];
  public readonly retryAfterSeconds?: number;

  constructor(options: ChatDomainErrorOptions) {
    super(options.message);
    this.name = 'ChatDomainError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
