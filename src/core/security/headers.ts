import 'server-only';

import { randomBytes } from 'node:crypto';

import { extractSentryIngestOrigin } from '@/core/monitoring/sentry-scrub';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';

export const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';
export const PERMISSIONS_POLICY_VALUE = 'camera=(), microphone=(), geolocation=()';
export const REFERRER_POLICY_VALUE = 'strict-origin-when-cross-origin';
export const NO_REFERRER_POLICY_VALUE = 'no-referrer';
export const API_CSP_VALUE = "default-src 'none'; frame-ancestors 'none'";

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const VERCEL_BLOB_IMAGE_ORIGIN = 'https://*.public.blob.vercel-storage.com';
const ABLY_CONNECT_ORIGINS = [
  'https://*.ably.io',
  'wss://*.ably.io',
  'https://*.ably-realtime.com',
  'wss://*.ably-realtime.com',
  'https://*.ably.net',
  'wss://*.ably.net',
] as const;

export interface SecurityHeadersContext {
  readonly nonce: string;
  readonly isProduction: boolean;
  readonly isHttps: boolean;
  readonly isApiRoute: boolean;
  readonly isAuthApiRoute: boolean;
  /** Bật `Referrer-Policy: no-referrer` + `Cache-Control: no-store` cho trang mang token nhạy cảm trên URL (ví dụ `/reset-password`). */
  readonly isSensitiveTokenPage?: boolean;
  /** Origin HTTPS duy nhất của Sentry ingest (trích từ `NEXT_PUBLIC_SENTRY_DSN`) để cho phép trong CSP `connect-src`. */
  readonly sentryDsnOrigin?: string | null;
  /** Chỉ mở các origin WSS/HTTPS chính thức của Ably trong `connect-src` khi Ably Realtime được kích hoạt. */
  readonly allowAblyRealtime?: boolean;
}

/**
 * Sinh nonce CSP 128-bit ngẫu nhiên mật mã học duy nhất cho mỗi HTTP request.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Xây dựng Content-Security-Policy chặt chẽ theo Mục 6.3:
 * - Production: dùng nonce + strict-dynamic, tuyệt đối KHÔNG có `'unsafe-eval'` hay `'unsafe-inline'` trong script-src.
 * - Cho phép `https://challenges.cloudflare.com` cho widget Cloudflare Turnstile.
 * - Chỉ thêm đúng 1 origin HTTPS của Sentry ingest (nếu cấu hình `NEXT_PUBLIC_SENTRY_DSN`).
 * - Chỉ bật `upgrade-insecure-requests` khi chạy Production HTTPS (tránh phá vỡ Local HTTP).
 */
export function buildContentSecurityPolicy(
  context: Pick<
    SecurityHeadersContext,
    'nonce' | 'isProduction' | 'isHttps' | 'isApiRoute' | 'sentryDsnOrigin' | 'allowAblyRealtime'
  >,
): string {
  if (context.isApiRoute) {
    return API_CSP_VALUE;
  }

  const scriptSources = [
    "'self'",
    `'nonce-${context.nonce}'`,
    "'strict-dynamic'",
    TURNSTILE_ORIGIN,
  ];
  if (!context.isProduction) {
    // React/Next.js dev mode cần eval cho dev error stack overlay; tuyệt đối cấm ở production.
    scriptSources.push("'unsafe-eval'");
  }

  const styleSources = context.isProduction
    ? ["'self'", `'nonce-${context.nonce}'`, TURNSTILE_ORIGIN]
    : ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN];

  const connectSources = ["'self'", TURNSTILE_ORIGIN];
  const safeSentryOrigin = extractSentryIngestOrigin(context.sentryDsnOrigin);
  if (safeSentryOrigin) {
    connectSources.push(safeSentryOrigin);
  }
  if (context.allowAblyRealtime) {
    connectSources.push(...ABLY_CONNECT_ORIGINS);
  }
  if (!context.isProduction) {
    // Cho phép WebSocket HMR của Next.js khi phát triển cục bộ.
    connectSources.push('ws:', 'wss:');
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${styleSources.join(' ')}`,
    // Tách tường minh `style-src-elem` (khóa chặt thẻ `<style>` theo nonce/'self') và chỉ mở `style-src-attr` cho thuộc tính `style="..."` động (pan/zoom, Radix, Turnstile).
    `style-src-elem ${styleSources.join(' ')}`,
    "style-src-attr 'unsafe-inline'",
    // Giữ `blob:` cho URL.createObjectURL khi người dùng cắt ảnh cục bộ và chỉ mở CDN ảnh đại diện Vercel Blob.
    `img-src 'self' data: blob: ${VERCEL_BLOB_IMAGE_ORIGIN}`,
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  if (context.isProduction && context.isHttps) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Tập hợp đầy đủ Security Headers bắt buộc theo Mục 6.3.
 */
export function buildSecurityHeaders(context: SecurityHeadersContext): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildContentSecurityPolicy(context),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': context.isSensitiveTokenPage
      ? NO_REFERRER_POLICY_VALUE
      : REFERRER_POLICY_VALUE,
    'Permissions-Policy': PERMISSIONS_POLICY_VALUE,
  };

  // Chỉ bật HSTS trên môi trường Production HTTPS để tránh trình duyệt ghim HTTPS ở localhost.
  if (context.isProduction && context.isHttps) {
    headers['Strict-Transport-Security'] = HSTS_HEADER_VALUE;
  }

  if (context.isAuthApiRoute || context.isSensitiveTokenPage) {
    headers['Cache-Control'] = AUTH_CACHE_CONTROL_HEADER;
    headers['Pragma'] = 'no-cache';
  }

  return headers;
}
