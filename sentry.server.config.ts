import * as Sentry from '@sentry/nextjs';

import {
  SENTRY_PRIVACY_DATA_COLLECTION,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@/core/monitoring/sentry-scrub';

const dsn = process.env.SENTRY_DSN?.trim() || undefined;
const isProduction = process.env.NODE_ENV === 'production';

Sentry.init({
  dsn,
  // Tự động tắt hoàn toàn khi không cấu hình SENTRY_DSN (dev/test cục bộ không gửi request ra ngoài).
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV ?? 'development',
  // Tắt thu thập tự động cookie, header, body, query params, tham số DB và PII theo chuẩn Sentry v11.
  dataCollection: SENTRY_PRIVACY_DATA_COLLECTION,
  // Lấy mẫu trace nhẹ 10% trên production để giữ trong hạn mức miễn phí Sentry Free.
  tracesSampleRate: isProduction ? 0.1 : 0,
  beforeSend: (event) => scrubSentryEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
});
