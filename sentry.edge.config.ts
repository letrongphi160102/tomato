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
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV ?? 'development',
  dataCollection: SENTRY_PRIVACY_DATA_COLLECTION,
  tracesSampleRate: isProduction ? 0.1 : 0,
  beforeSend: (event) => scrubSentryEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
});
