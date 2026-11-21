import 'server-only';

import type { NextResponse } from 'next/server';

export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = 15 * 60;
export const REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const CSRF_TOKEN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface TomatoCookieNames {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

export interface CookieSecurityAttributes {
  readonly httpOnly: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly secure: boolean;
  readonly maxAge: number;
}

export function isProductionCookieEnv(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'production';
}

/**
 * Trên Production HTTPS dùng prefix `__Host-` để ngăn subdomain ghi đè cookie (cookie tossing).
 * Ở môi trường Local HTTP (`development`/`test`) tự động bỏ prefix để trình duyệt không từ chối cookie.
 */
export function getCookieNames(isProduction = isProductionCookieEnv()): TomatoCookieNames {
  const prefix = isProduction ? '__Host-' : '';
  return {
    accessToken: `${prefix}tomato_at`,
    refreshToken: `${prefix}tomato_rt`,
    csrfToken: `${prefix}tomato_csrf`,
  };
}

/**
 * Thuộc tính cookie chuẩn cho Access/Refresh Token.
 * Tuyệt đối KHÔNG khai báo thuộc tính `domain` vì chuẩn `__Host-` cấm chỉ định `Domain`.
 */
export function buildAuthCookieOptions(
  maxAgeSeconds: number,
  isProduction = isProductionCookieEnv(),
): CookieSecurityAttributes {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProduction,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Cookie CSRF dùng cho cơ chế Double-Submit nên cần `httpOnly: false`
 * để frontend cùng origin đọc và gửi lại qua header `X-CSRF-Token`.
 */
export function buildCsrfCookieOptions(
  maxAgeSeconds = CSRF_TOKEN_COOKIE_MAX_AGE_SECONDS,
  isProduction = isProductionCookieEnv(),
): CookieSecurityAttributes {
  return {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    secure: isProduction,
    maxAge: maxAgeSeconds,
  };
}

export interface SetAuthCookiesInput {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken?: string;
}

export interface SetAuthCookiesOptions {
  readonly isProduction?: boolean;
  readonly accessTokenMaxAgeSeconds?: number;
  readonly refreshTokenMaxAgeSeconds?: number;
  readonly csrfTokenMaxAgeSeconds?: number;
}

export function setAuthCookies(
  response: NextResponse,
  tokens: SetAuthCookiesInput,
  options: SetAuthCookiesOptions = {},
): void {
  const isProduction = options.isProduction ?? isProductionCookieEnv();
  const names = getCookieNames(isProduction);

  response.cookies.set(
    names.accessToken,
    tokens.accessToken,
    buildAuthCookieOptions(
      options.accessTokenMaxAgeSeconds ?? ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
      isProduction,
    ),
  );

  response.cookies.set(
    names.refreshToken,
    tokens.refreshToken,
    buildAuthCookieOptions(
      options.refreshTokenMaxAgeSeconds ?? REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
      isProduction,
    ),
  );

  if (tokens.csrfToken) {
    response.cookies.set(
      names.csrfToken,
      tokens.csrfToken,
      buildCsrfCookieOptions(
        options.csrfTokenMaxAgeSeconds ?? CSRF_TOKEN_COOKIE_MAX_AGE_SECONDS,
        isProduction,
      ),
    );
  }
}

export function setCsrfCookie(
  response: NextResponse,
  csrfToken: string,
  options: { readonly isProduction?: boolean; readonly maxAgeSeconds?: number } = {},
): void {
  const isProduction = options.isProduction ?? isProductionCookieEnv();
  const names = getCookieNames(isProduction);

  response.cookies.set(
    names.csrfToken,
    csrfToken,
    buildCsrfCookieOptions(
      options.maxAgeSeconds ?? CSRF_TOKEN_COOKIE_MAX_AGE_SECONDS,
      isProduction,
    ),
  );
}

export function clearAuthCookies(
  response: NextResponse,
  options: { readonly isProduction?: boolean; readonly clearCsrf?: boolean } = {},
): void {
  const isProduction = options.isProduction ?? isProductionCookieEnv();
  const names = getCookieNames(isProduction);

  response.cookies.set(names.accessToken, '', buildAuthCookieOptions(0, isProduction));
  response.cookies.set(names.refreshToken, '', buildAuthCookieOptions(0, isProduction));

  if (options.clearCsrf) {
    response.cookies.set(names.csrfToken, '', buildCsrfCookieOptions(0, isProduction));
  }
}

/**
 * Phân tích header `Cookie` thô theo RFC 6265 để hoạt động đồng nhất với cả `Request` chuẩn và `NextRequest`.
 */
export function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) {
    return map;
  }

  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const rawName = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();
    if (!rawName) {
      continue;
    }

    try {
      map.set(rawName, decodeURIComponent(rawValue));
    } catch {
      map.set(rawName, rawValue);
    }
  }

  return map;
}

export function getCookieFromRequest(request: Request, cookieName: string): string | null {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  return cookies.get(cookieName) ?? null;
}
