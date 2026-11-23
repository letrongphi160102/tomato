import 'server-only';

import { createTransport, type Transporter } from 'nodemailer';

import { EmailDeliveryError, type EmailMessage, type EmailProvider } from '@/core/email/types';
import { logger } from '@/core/logger';

export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_GREETING_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;

export interface GmailSmtpAdapterOptions {
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly connectionTimeoutMs?: number;
  readonly greetingTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  /** Cho phép inject transporter giả lập trong unit test. */
  readonly transporter?: Transporter;
}

/**
 * Adapter gửi email Production 0đ qua Gmail SMTP + App Password (không cần tên miền riêng).
 * Luôn ép mã hóa TLS (mặc định SMTPS cổng 465 `secure: true`, hoặc `requireTLS: true` với cổng 587)
 * và tuyệt đối không ghi log App Password hay nội dung OTP/liên kết đặt lại mật khẩu.
 */
export class GmailSmtpAdapter implements EmailProvider {
  public readonly provider = 'gmail' as const;

  private readonly from: string;
  private readonly transporter: Transporter;

  constructor(options: GmailSmtpAdapterOptions) {
    const trimmedFrom = options.from.trim();
    if (!trimmedFrom) {
      throw new Error('EMAIL_FROM là bắt buộc để khởi tạo GmailSmtpAdapter');
    }
    this.from = trimmedFrom;

    if (options.transporter) {
      this.transporter = options.transporter;
      return;
    }

    const trimmedUser = options.user.trim();
    const trimmedPass = options.pass.trim();
    if (!trimmedUser || !trimmedPass) {
      throw new Error(
        'SMTP_USER và SMTP_PASS (Gmail App Password) là bắt buộc cho GmailSmtpAdapter',
      );
    }

    const port = options.port ?? GMAIL_SMTP_PORT;
    const secure = options.secure ?? port === GMAIL_SMTP_PORT;

    this.transporter = createTransport({
      host: (options.host ?? GMAIL_SMTP_HOST).trim(),
      port,
      secure,
      // Chặn downgrade về plaintext khi chạy STARTTLS trên cổng 587.
      requireTLS: !secure,
      auth: {
        user: trimmedUser,
        pass: trimmedPass,
      },
      connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      greetingTimeout: options.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS,
      socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (error) {
      const errObj =
        typeof error === 'object' && error !== null
          ? (error as {
              readonly code?: unknown;
              readonly responseCode?: unknown;
              readonly name?: unknown;
            })
          : null;
      // Tuyệt đối không log `message.html`, `message.text`, `message.subject` hay thông tin Gmail App Password.
      logger.error(
        {
          component: 'email',
          provider: this.provider,
          errorCode:
            typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
              ? errObj.code
              : 'GMAIL_SMTP_SEND_FAILED',
          responseCode: typeof errObj?.responseCode === 'number' ? errObj.responseCode : null,
          errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
        },
        'Gửi email qua Gmail SMTP thất bại',
      );
      throw new EmailDeliveryError(this.provider, 'Không thể gửi email qua Gmail SMTP', {
        cause: error,
      });
    }
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
