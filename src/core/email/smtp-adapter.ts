import 'server-only';

import { createTransport, type Transporter } from 'nodemailer';

import { logger } from '@/core/logger';
import { EmailDeliveryError, type EmailMessage, type EmailProvider } from '@/core/email/types';

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_GREETING_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;

export interface SmtpEmailAdapterOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  readonly user?: string;
  readonly pass?: string;
  readonly connectionTimeoutMs?: number;
  readonly greetingTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  /** Cho phép inject transporter giả lập trong unit test. */
  readonly transporter?: Transporter;
}

/**
 * Adapter gửi email qua SMTP (Mailpit ở local, Gmail App Password ở production).
 * Không bao giờ ghi log nội dung email (HTML/text/subject) vì chứa mã OTP nhạy cảm.
 */
export class SmtpEmailAdapter implements EmailProvider {
  public readonly provider = 'smtp' as const;

  private readonly from: string;
  private readonly transporter: Transporter;

  constructor(options: SmtpEmailAdapterOptions) {
    if (!options.from.trim()) {
      throw new Error('EMAIL_FROM là bắt buộc để khởi tạo SmtpEmailAdapter');
    }
    this.from = options.from.trim();

    if (options.transporter) {
      this.transporter = options.transporter;
      return;
    }

    if (!options.host.trim()) {
      throw new Error('SMTP_HOST là bắt buộc để khởi tạo SmtpEmailAdapter');
    }

    const auth =
      options.user && options.pass
        ? {
            user: options.user,
            pass: options.pass,
          }
        : undefined;

    this.transporter = createTransport({
      host: options.host.trim(),
      port: options.port,
      secure: options.secure,
      auth,
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
      const err = error as Error & { code?: string; responseCode?: number };
      // Tuyệt đối không log `message.html`, `message.text`, `message.subject` hay thông tin SMTP auth.
      logger.error(
        {
          component: 'email',
          provider: this.provider,
          errorCode: err.code ?? 'SMTP_SEND_FAILED',
          responseCode: err.responseCode ?? null,
          errorName: err.name ?? 'Error',
        },
        'Gửi email qua SMTP thất bại',
      );
      throw new EmailDeliveryError(this.provider, 'Không thể gửi email qua máy chủ SMTP', {
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
