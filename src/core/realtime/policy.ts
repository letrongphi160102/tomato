import 'server-only';

import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { isActiveSocialActor } from '@/modules/social/social.policy';

export type RealtimeAction = 'realtime:token' | 'realtime:subscribe';

/**
 * Policy tập trung cho hạ tầng Realtime (Deny-by-default, fail-closed):
 * chỉ tài khoản đang hoạt động với phiên chưa thu hồi mới được cấp token hoặc mở kênh nghe cá nhân.
 */
export function authorizeRealtimeAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: RealtimeAction,
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }
  switch (action) {
    case 'realtime:token':
    case 'realtime:subscribe':
      return Boolean(actor.user.publicId);
    default:
      return false;
  }
}
