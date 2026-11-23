import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import {
  BREVO_SMTP_EMAIL_ENDPOINT,
  BrevoEmailAdapter,
  parseEmailSenderHeader,
  type BrevoEmailAdapterOptions,
  type ParsedEmailSender,
} from '@/core/email/brevo-adapter';
import {
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GmailSmtpAdapter,
  type GmailSmtpAdapterOptions,
} from '@/core/email/gmail-smtp-adapter';
import { SmtpEmailAdapter, type SmtpEmailAdapterOptions } from '@/core/email/smtp-adapter';
import {
  buildAccountLockedAlertEmail,
  buildDuplicateRegistrationEmail,
  buildPasswordChangeOtpEmail,
  buildPasswordChangedAlertEmail,
  buildPasswordResetAlertEmail,
  buildPasswordResetLinkEmail,
  buildVerificationOtpEmail,
  escapeHtml,
  type AccountLockedAlertEmailData,
  type DuplicateRegistrationEmailData,
  type PasswordChangeOtpEmailData,
  type PasswordResetLinkEmailData,
  type PasswordSecurityAlertEmailData,
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
  BREVO_SMTP_EMAIL_ENDPOINT,
  BrevoEmailAdapter,
  EmailDeliveryError,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GmailSmtpAdapter,
  SmtpEmailAdapter,
  buildAccountLockedAlertEmail,
  buildDuplicateRegistrationEmail,
  buildPasswordChangeOtpEmail,
  buildPasswordChangedAlertEmail,
  buildPasswordResetAlertEmail,
  buildPasswordResetLinkEmail,
  buildVerificationOtpEmail,
  escapeHtml,
  parseEmailSenderHeader,
  type AccountLockedAlertEmailData,
  type BrevoEmailAdapterOptions,
  type DuplicateRegistrationEmailData,
  type EmailMessage,
  type EmailProvider,
  type EmailProviderType,
  type GmailSmtpAdapterOptions,
  type ParsedEmailSender,
  type PasswordChangeOtpEmailData,
  type PasswordResetLinkEmailData,
  type PasswordSecurityAlertEmailData,
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
  if (config.EMAIL_PROVIDER === 'mailpit') {
    return new SmtpEmailAdapter({
      host: config.SMTP_HOST ?? '127.0.0.1',
      port: config.SMTP_PORT ?? 1025,
      secure: false,
      from: config.EMAIL_FROM,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    });
  }

  if (config.EMAIL_PROVIDER === 'gmail') {
    if (!config.SMTP_USER || !config.SMTP_PASS) {
      throw new Error('Thiếu SMTP_USER hoặc SMTP_PASS (Gmail App Password) cho GmailSmtpAdapter');
    }
    const port = config.SMTP_PORT ?? GMAIL_SMTP_PORT;
    return new GmailSmtpAdapter({
      host: config.SMTP_HOST ?? GMAIL_SMTP_HOST,
      port,
      secure: port === GMAIL_SMTP_PORT ? true : config.SMTP_SECURE,
      from: config.EMAIL_FROM,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    });
  }

  if (config.EMAIL_PROVIDER === 'brevo') {
    if (!config.BREVO_API_KEY) {
      throw new Error('Thiếu BREVO_API_KEY cho BrevoEmailAdapter');
    }
    return new BrevoEmailAdapter({
      apiKey: config.BREVO_API_KEY,
      from: config.EMAIL_FROM,
    });
  }

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

  throw new Error(`Email provider không được hỗ trợ: "${String(config.EMAIL_PROVIDER)}"`);
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
