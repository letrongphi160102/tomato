import 'server-only';

import { EmailDeliveryError, type EmailMessage, type EmailProvider } from '@/core/email/types';
import { logger } from '@/core/logger';

export const BREVO_SMTP_EMAIL_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

const DEFAULT_TIMEOUT_MS = 10_000;
const NAMED_ADDRESS_REGEX = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/;
const PLAIN_EMAIL_REGEX = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface ParsedEmailSender {
  readonly name?: string;
  readonly email: string;
}

/**
 * Tách chuỗi `EMAIL_FROM` dạng `Tomato <no-reply@example.com>` hoặc `no-reply@example.com`
 * sang đối tượng `{ name?, email }` theo đặc tả Brevo REST API v3.
 */
export function parseEmailSenderHeader(rawFrom: string): ParsedEmailSender {
  const trimmed = rawFrom.trim();
  if (!trimmed) {
    throw new Error('EMAIL_FROM là bắt buộc để khởi tạo BrevoEmailAdapter');
  }

  const namedMatch = NAMED_ADDRESS_REGEX.exec(trimmed);
  if (namedMatch) {
    const rawName = (namedMatch[1] ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    const email = (namedMatch[2] ?? '').trim();
    if (!PLAIN_EMAIL_REGEX.test(email)) {
      throw new Error('Địa chỉ email trong EMAIL_FROM không hợp lệ');
    }
    return rawName ? { name: rawName, email } : { email };
  }

  if (!PLAIN_EMAIL_REGEX.test(trimmed)) {
    throw new Error('EMAIL_FROM phải có dạng "Tên <email@domain>" hoặc "email@domain"');
  }

  return { email: trimmed };
}

export interface BrevoEmailAdapterOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Cho phép inject `fetch` trong unit test để kiểm thử đầy đủ HTTP error/timeout. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Adapter gửi email Production 0đ qua Brevo Transactional Email REST API v3
 * (`POST https://api.brevo.com/v3/smtp/email`) bằng `fetch` chuẩn Node.js (không cần SDK phụ thuộc ngoài).
 */
export class BrevoEmailAdapter implements EmailProvider {
  public readonly provider = 'brevo' as const;

  private readonly apiKey: string;
  private readonly sender: ParsedEmailSender;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: BrevoEmailAdapterOptions) {
    const trimmedKey = options.apiKey.trim();
    if (!trimmedKey) {
      throw new Error('BREVO_API_KEY là bắt buộc để khởi tạo BrevoEmailAdapter');
    }

    this.apiKey = trimmedKey;
    this.sender = parseEmailSenderHeader(options.from);
    this.endpoint = options.endpoint ?? BREVO_SMTP_EMAIL_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl;
  }

  async send(message: EmailMessage): Promise<void> {
    const fetchFn = this.fetchImpl ?? fetch;

    try {
      const response = await fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify({
          sender: this.sender,
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        // Tuyệt đối không log `api-key`, nội dung email hay response body có thể chứa dữ liệu người nhận.
        logger.error(
          {
            component: 'email',
            provider: this.provider,
            httpStatus: response.status,
            errorCode: `BREVO_HTTP_${response.status}`,
          },
          'Gửi email qua Brevo REST API trả mã HTTP không thành công',
        );
        throw new EmailDeliveryError(this.provider, 'Không thể gửi email qua Brevo API');
      }
    } catch (error) {
      if (error instanceof EmailDeliveryError) {
        throw error;
      }

      const errObj =
        typeof error === 'object' && error !== null
          ? (error as { readonly code?: unknown; readonly name?: unknown })
          : null;
      logger.error(
        {
          component: 'email',
          provider: this.provider,
          errorCode:
            typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
              ? errObj.code
              : 'BREVO_NETWORK_ERROR',
          errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
        },
        'Gửi email qua Brevo REST API thất bại do lỗi kết nối',
      );
      throw new EmailDeliveryError(this.provider, 'Không thể gửi email qua Brevo API', {
        cause: error,
      });
    }
  }
}
