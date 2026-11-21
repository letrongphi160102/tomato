import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import { SmtpEmailAdapter, type SmtpEmailAdapterOptions } from '@/core/email/smtp-adapter';
import {
  buildDuplicateRegistrationEmail,
  buildVerificationOtpEmail,
  escapeHtml,
  type DuplicateRegistrationEmailData,
  type RenderedEmailTemplate,
  type VerificationOtpEmailData,
} from '@/core/email/templates';
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailProvider,
  type EmailProviderType,
} from '@/core/email/types';

export {
  EmailDeliveryError,
  SmtpEmailAdapter,
  buildDuplicateRegistrationEmail,
  buildVerificationOtpEmail,
  escapeHtml,
  type DuplicateRegistrationEmailData,
  type EmailMessage,
  type EmailProvider,
  type EmailProviderType,
  type RenderedEmailTemplate,
  type SmtpEmailAdapterOptions,
  type VerificationOtpEmailData,
};

type EmailEnvConfig = Pick<
  Env,
  | 'EMAIL_PROVIDER'
  | 'EMAIL_FROM'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_SECURE'
  | 'SMTP_USER'
  | 'SMTP_PASS'
  | 'BREVO_API_KEY'
>;

export function createEmailProvider(config: EmailEnvConfig): EmailProvider {
  if (config.EMAIL_PROVIDER === 'smtp') {
    if (!config.SMTP_HOST || config.SMTP_PORT === undefined) {
      throw new Error('Thiếu SMTP_HOST hoặc SMTP_PORT cho SmtpEmailAdapter');
    }
    return new SmtpEmailAdapter({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      from: config.EMAIL_FROM,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    });
  }

  throw new Error(
    `Email provider "${config.EMAIL_PROVIDER}" chưa được kích hoạt trong Cột mốc M2 (chỉ hỗ trợ "smtp")`,
  );
}

const globalForEmail = globalThis as typeof globalThis & {
  __tomatoEmailProvider?: EmailProvider;
};

export function getEmailProvider(): EmailProvider {
  if (!globalForEmail.__tomatoEmailProvider) {
    globalForEmail.__tomatoEmailProvider = createEmailProvider(getEnv());
  }
  return globalForEmail.__tomatoEmailProvider;
}

export async function closeEmailProvider(): Promise<void> {
  if (globalForEmail.__tomatoEmailProvider) {
    const provider = globalForEmail.__tomatoEmailProvider;
    globalForEmail.__tomatoEmailProvider = undefined;
    await provider.close?.();
  }
}
