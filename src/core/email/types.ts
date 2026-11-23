import 'server-only';

export type EmailProviderType = 'mailpit' | 'gmail' | 'brevo' | 'smtp' | 'memory';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Port trừu tượng gửi email (Mục 1.1) tách biệt tầng nghiệp vụ Auth khỏi Mailpit/Gmail SMTP/Brevo/SES.
 */
export interface EmailProvider {
  readonly provider: EmailProviderType;
  send(message: EmailMessage): Promise<void>;
  verify?(): Promise<boolean>;
  close?(): Promise<void>;
}

export class EmailDeliveryError extends Error {
  public readonly provider: EmailProviderType;

  constructor(provider: EmailProviderType, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmailDeliveryError';
    this.provider = provider;
  }
}
