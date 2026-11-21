import 'server-only';

import { logger } from '@/core/logger';
import type {
  CaptchaProvider,
  CaptchaVerifyInput,
  CaptchaVerifyResult,
} from '@/core/captcha/types';

export const TURNSTILE_VERIFY_ENDPOINT =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// 3 khóa bí mật thử nghiệm công khai chính thức của Cloudflare Turnstile (chỉ cho phép ở dev/test).
export const CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS = '1x0000000000000000000000000000000AA';
export const CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL = '2x0000000000000000000000000000000AA';
export const CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT = '3x0000000000000000000000000000000AA';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CAPTCHA_TOKEN_LENGTH = 4_096;

interface TurnstileSiteverifyResponse {
  readonly success?: unknown;
  readonly action?: unknown;
  readonly 'error-codes'?: unknown;
}

export interface TurnstileAdapterOptions {
  readonly secretKey: string;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Cho phép inject hàm `fetch` trong unit test để kiểm thử trọn vẹn xử lý HTTP/timeout. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Adapter xác thực Cloudflare Turnstile phía máy chủ theo nguyên tắc Fail-Closed:
 * mọi lỗi mạng, timeout, HTTP != 200 hoặc phản hồi sai định dạng đều bị từ chối.
 */
export class TurnstileAdapter implements CaptchaProvider {
  public readonly provider = 'turnstile' as const;

  private readonly secretKey: string;
  private readonly nodeEnv: 'development' | 'test' | 'production';
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: TurnstileAdapterOptions) {
    if (!options.secretKey.trim()) {
      throw new Error('TURNSTILE_SECRET_KEY là bắt buộc để khởi tạo TurnstileAdapter');
    }
    this.secretKey = options.secretKey.trim();
    this.nodeEnv = options.nodeEnv;
    this.endpoint = options.endpoint ?? TURNSTILE_VERIFY_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl;
  }

  async verify(input: CaptchaVerifyInput): Promise<CaptchaVerifyResult> {
    const trimmedToken = input.token.trim();
    if (!trimmedToken || trimmedToken.length > MAX_CAPTCHA_TOKEN_LENGTH) {
      return { success: false, errorCodes: ['missing-input-response'] };
    }

    // Trong môi trường test tự động (NODE_ENV=test) không inject fetch riêng: mô phỏng đúng
    // hợp đồng 3 dummy secret key chính thức của Cloudflare để integration test không phụ thuộc
    // internet ra ngoài. Tuyệt đối KHÔNG bao giờ chạy nhánh này ở development hay production.
    if (this.nodeEnv === 'test' && !this.fetchImpl) {
      const dummyResult = this.evaluateOfficialDummySecret(this.secretKey);
      if (dummyResult) {
        return dummyResult;
      }
    }

    const body = new URLSearchParams({
      secret: this.secretKey,
      response: trimmedToken,
    });
    if (input.remoteIp && input.remoteIp.trim()) {
      body.set('remoteip', input.remoteIp.trim());
    }

    const fetchFn = this.fetchImpl ?? fetch;

    try {
      const response = await fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logger.warn(
          {
            component: 'captcha',
            provider: this.provider,
            httpStatus: response.status,
          },
          'Cloudflare Turnstile siteverify trả mã HTTP không thành công',
        );
        return { success: false, errorCodes: [`http-${response.status}`] };
      }

      const payload = (await response.json()) as TurnstileSiteverifyResponse;
      const errorCodes = Array.isArray(payload['error-codes'])
        ? payload['error-codes'].filter((code): code is string => typeof code === 'string')
        : [];

      if (payload.success !== true) {
        return {
          success: false,
          errorCodes: errorCodes.length > 0 ? errorCodes : ['verification-failed'],
        };
      }

      if (
        input.expectedAction &&
        typeof payload.action === 'string' &&
        payload.action.length > 0 &&
        payload.action !== input.expectedAction
      ) {
        return {
          success: false,
          errorCodes: ['action-mismatch'],
        };
      }

      return { success: true, errorCodes: [] };
    } catch (error) {
      const errObj =
        typeof error === 'object' && error !== null
          ? (error as { readonly code?: unknown; readonly name?: unknown })
          : null;
      // Không bao giờ log captchaToken hay TURNSTILE_SECRET_KEY.
      logger.error(
        {
          component: 'captcha',
          provider: this.provider,
          errorCode:
            typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
              ? errObj.code
              : 'NETWORK_ERROR',
          errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
        },
        'Lỗi kết nối khi xác thực Cloudflare Turnstile (fail-closed)',
      );
      return { success: false, errorCodes: ['network-error'] };
    }
  }

  private evaluateOfficialDummySecret(secret: string): CaptchaVerifyResult | null {
    if (secret === CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS) {
      return { success: true, errorCodes: [] };
    }
    if (secret === CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL) {
      return { success: false, errorCodes: ['invalid-input-response'] };
    }
    if (secret === CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT) {
      return { success: false, errorCodes: ['timeout-or-duplicate'] };
    }
    return null;
  }
}
