import { NextResponse, type NextRequest } from 'next/server';

import { getCookieNames } from '@/core/security/cookies';
import { buildSecurityHeaders, generateCspNonce } from '@/core/security/headers';
import { AUTH_CACHE_CONTROL_HEADER } from '@/core/security/http-response';

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

function isProtectedSettingsRoute(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

function isSensitiveTokenPageRoute(pathname: string): boolean {
  return pathname === '/reset-password' || pathname.startsWith('/reset-password/');
}

/**
 * Next.js 16 Proxy (thay thế `middleware.ts` đã deprecated):
 * - Sinh CSP nonce duy nhất cho mỗi request và chuyển tiếp qua header `x-nonce` cho SSR.
 * - Gắn toàn bộ Security Headers (CSP, X-Content-Type-Options, X-Frame-Options,
 *   Referrer-Policy, Permissions-Policy, và HSTS khi chạy Production HTTPS).
 * - Ép `Referrer-Policy: no-referrer` + `Cache-Control: no-store` cho `/reset-password` để chống rò rỉ token qua Referer/cache.
 * - Gắn phòng thủ `Cache-Control: no-store, max-age=0` cho mọi endpoint `/api/v1/auth/*` và `/settings/*`.
 * - Bảo vệ route `/settings/*`: chuyển hướng về `/login` nếu người dùng hoàn toàn chưa có
 *   cả cookie Access Token lẫn Refresh Token (giữ lại quyền auto-refresh khi AT vừa hết hạn 15 phút).
 */
export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isProduction = process.env.NODE_ENV === 'production';
  const isHttps = isHttpsRequest(request);
  const isApiRoute = pathname.startsWith('/api/');
  const isAuthApiRoute = pathname === '/api/v1/auth' || pathname.startsWith('/api/v1/auth/');
  const isProtectedRoute = isProtectedSettingsRoute(pathname);
  const isSensitiveTokenPage = isSensitiveTokenPageRoute(pathname);

  const nonce = generateCspNonce();
  const securityHeaders = buildSecurityHeaders({
    nonce,
    isProduction,
    isHttps,
    isApiRoute,
    isAuthApiRoute,
    isSensitiveTokenPage,
  });

  if (isProtectedRoute) {
    const cookieNames = getCookieNames(isProduction);
    const hasAccessCookie = Boolean(request.cookies.get(cookieNames.accessToken)?.value);
    const hasRefreshCookie = Boolean(request.cookies.get(cookieNames.refreshToken)?.value);

    if (!hasAccessCookie && !hasRefreshCookie) {
      const loginUrl = new URL('/login', request.url);
      const nextPath = `${pathname}${request.nextUrl.search}`;
      loginUrl.searchParams.set('next', nextPath);

      const redirectResponse = NextResponse.redirect(loginUrl, 307);
      for (const [headerName, headerValue] of Object.entries(securityHeaders)) {
        redirectResponse.headers.set(headerName, headerValue);
      }
      redirectResponse.headers.set('Cache-Control', AUTH_CACHE_CONTROL_HEADER);
      redirectResponse.headers.set('Pragma', 'no-cache');
      return redirectResponse;
    }
  }

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

  if (isProtectedRoute) {
    response.headers.set('Cache-Control', AUTH_CACHE_CONTROL_HEADER);
    response.headers.set('Pragma', 'no-cache');
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
