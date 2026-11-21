import 'server-only';

import { getEnv, type Env } from '@/core/config/env';
import {
  CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS,
  TURNSTILE_VERIFY_ENDPOINT,
  TurnstileAdapter,
  type TurnstileAdapterOptions,
} from '@/core/captcha/turnstile-adapter';
import type {
  CaptchaProvider,
  CaptchaProviderType,
  CaptchaVerifyInput,
  CaptchaVerifyResult,
} from '@/core/captcha/types';

export {
  CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS,
  TURNSTILE_VERIFY_ENDPOINT,
  TurnstileAdapter,
  type CaptchaProvider,
  type CaptchaProviderType,
  type CaptchaVerifyInput,
  type CaptchaVerifyResult,
  type TurnstileAdapterOptions,
};

type CaptchaEnvConfig = Pick<Env, 'TURNSTILE_SECRET_KEY' | 'NODE_ENV'>;

export function createCaptchaProvider(config: CaptchaEnvConfig): CaptchaProvider {
  return new TurnstileAdapter({
    secretKey: config.TURNSTILE_SECRET_KEY,
    nodeEnv: config.NODE_ENV,
  });
}

const globalForCaptcha = globalThis as typeof globalThis & {
  __tomatoCaptchaProvider?: CaptchaProvider;
};

export function getCaptchaProvider(): CaptchaProvider {
  if (!globalForCaptcha.__tomatoCaptchaProvider) {
    globalForCaptcha.__tomatoCaptchaProvider = createCaptchaProvider(getEnv());
  }
  return globalForCaptcha.__tomatoCaptchaProvider;
}

export function resetCaptchaProviderForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetCaptchaProviderForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForCaptcha.__tomatoCaptchaProvider = undefined;
}
