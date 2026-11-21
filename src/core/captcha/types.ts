import 'server-only';

export type CaptchaProviderType = 'turnstile' | 'stub';

export interface CaptchaVerifyInput {
  readonly token: string;
  readonly remoteIp?: string | null;
  readonly expectedAction?: string;
}

export interface CaptchaVerifyResult {
  readonly success: boolean;
  readonly errorCodes: readonly string[];
}

/**
 * Port trừu tượng xác thực chống bot (Mục 1.1) tách nghiệp vụ Auth khỏi Cloudflare Turnstile.
 */
export interface CaptchaProvider {
  readonly provider: CaptchaProviderType;
  verify(input: CaptchaVerifyInput): Promise<CaptchaVerifyResult>;
}
