import '@/core/validation/zod-config';
import * as Sentry from '@sentry/nextjs';

import {
  SENTRY_PRIVACY_DATA_COLLECTION,
  isThirdPartyBrowserNoiseEvent,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@/core/monitoring/sentry-scrub';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined;
const isProduction = process.env.NODE_ENV === 'production';

// Không bật Session Replay trên phân hệ xác thực để tránh tuyệt đối nguy cơ ghi lại
// thao tác nhập mật khẩu, mã OTP hoặc token khôi phục tài khoản.
Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV ?? 'development',
  dataCollection: SENTRY_PRIVACY_DATA_COLLECTION,
  tracesSampleRate: isProduction ? 0.1 : 0,
  ignoreErrors: [
    /\bzaloJSV2\s+is\s+not\s+defined\b/i,
    /\bWeixinJSBridge\s+is\s+not\s+defined\b/i,
    /\b__gCrWeb\b/i,
  ],
  beforeSend: (event) => (isThirdPartyBrowserNoiseEvent(event) ? null : scrubSentryEvent(event)),
  beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
