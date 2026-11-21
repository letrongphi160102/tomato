import { NextResponse, type NextRequest } from 'next/server';

import { buildSecurityHeaders, generateCspNonce } from '@/core/security/headers';

function isHttpsRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwardedProto) {
    return forwardedProto.toLowerCase() === 'https';
  }
  if (request.nextUrl.protocol === 'https:') {
    return true;
  }
  return process.env.APP_URL?.startsWith('https://') ?? false;
}

/**
 * Next.js 16 Proxy (thay thế `middleware.ts` đã deprecated):
 * - Sinh CSP nonce duy nhất cho mỗi request và chuyển tiếp qua header `x-nonce` cho SSR.
 * - Gắn toàn bộ Security Headers (CSP, X-Content-Type-Options, X-Frame-Options,
 *   Referrer-Policy, Permissions-Policy, và HSTS khi chạy Production HTTPS).
 * - Gắn phòng thủ `Cache-Control: no-store, max-age=0` cho mọi endpoint `/api/v1/auth/*`.
 */
export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isProduction = process.env.NODE_ENV === 'production';
  const isHttps = isHttpsRequest(request);
  const isApiRoute = pathname.startsWith('/api/');
  const isAuthApiRoute = pathname === '/api/v1/auth' || pathname.startsWith('/api/v1/auth/');

  const nonce = generateCspNonce();
  const securityHeaders = buildSecurityHeaders({
    nonce,
    isProduction,
    isHttps,
    isApiRoute,
    isAuthApiRoute,
  });

  const requestHeaders = new Headers(request.headers);
  if (!isApiRoute) {
    // Next.js trích xuất nonce từ header Content-Security-Policy trên request để tự động gắn vào script framework.
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', securityHeaders['Content-Security-Policy'] ?? '');
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  for (const [headerName, headerValue] of Object.entries(securityHeaders)) {
    response.headers.set(headerName, headerValue);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Áp dụng cho toàn bộ trang web và API routes, bỏ qua tài nguyên tĩnh không cần chạy proxy.
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
