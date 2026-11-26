import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';

import { getCookieNames } from '@/core/security/cookies';
import {
  getSessionService,
  toPublicUserProfile,
  type AuthenticatedPrincipal,
  type PublicUserProfile,
} from '@/modules/auth';
import { toUserProfileDto, type UserProfileDto } from '@/modules/profile';

export type ServerAuthState =
  | {
      readonly status: 'authenticated';
      readonly user: PublicUserProfile;
      readonly profile: UserProfileDto;
      readonly principal: AuthenticatedPrincipal;
      /** Thời gian sống còn lại (ms) của Access Token hiện tại để client làm mới chủ động, tránh lệch đồng hồ. */
      readonly accessTokenRemainingMs?: number;
    }
  | { readonly status: 'needs_refresh' }
  | { readonly status: 'unauthenticated' };

/**
 * Xác định trạng thái phiên đăng nhập phía Server Component (Next.js App Router) mà KHÔNG xoay vòng
 * Refresh Token trong request GET:
 * - Nếu cookie Access Token còn hợp lệ trong PostgreSQL -> trả ngay `authenticated` (0 nhấp nháy UI).
 * - Nếu Access Token đã hết hạn/thiếu nhưng còn cookie Refresh Token -> trả `needs_refresh` để Client
 *   chạy Single-Flight Silent Refresh qua `POST /api/v1/auth/refresh` (giữ đủ 3 lớp phòng thủ CSRF).
 * - Ngược lại -> `unauthenticated`.
 */
export const resolveServerAuthState = cache(async (): Promise<ServerAuthState> => {
  const cookieStore = await cookies();
  const names = getCookieNames();
  const accessToken = cookieStore.get(names.accessToken)?.value ?? null;
  const refreshToken = cookieStore.get(names.refreshToken)?.value ?? null;

  if (accessToken) {
    try {
      const principal = await getSessionService().authenticateAccessToken(accessToken);
      const accessTokenRemainingMs =
        typeof principal.accessTokenExpiresAtMs === 'number'
          ? Math.max(0, principal.accessTokenExpiresAtMs - Date.now())
          : undefined;
      return {
        status: 'authenticated',
        user: toPublicUserProfile(principal.user),
        profile: toUserProfileDto(principal.user, principal.user.id),
        principal,
        accessTokenRemainingMs,
      };
    } catch {
      // Access Token có thể vừa hết hạn 15 phút; rơi xuống kiểm tra Refresh Token bên dưới.
    }
  }

  if (refreshToken) {
    return { status: 'needs_refresh' };
  }

  return { status: 'unauthenticated' };
});
