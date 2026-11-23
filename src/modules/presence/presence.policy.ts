import 'server-only';

import type { UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { PresenceDomainError } from '@/modules/presence/presence.errors';
import { PRESENCE_MESSAGES } from '@/modules/presence/presence.messages';
import { isActiveSocialActor, isActiveSocialTarget } from '@/modules/social/social.policy';

export type PresenceAction = 'presence:heartbeat' | 'presence:query';

export type PresencePolicyUser = Pick<UserRow, 'id' | 'status' | 'deletedAt' | 'showActiveStatus'>;

export interface PresenceVisibilityContext {
  readonly viewer: PresencePolicyUser | null | undefined;
  readonly target: PresencePolicyUser | null | undefined;
  readonly isBidirectionallyBlocked: boolean;
  readonly isMutualFollow: boolean;
  readonly hasPrimaryConversation: boolean;
}

export function authorizePresenceAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: PresenceAction,
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }
  switch (action) {
    case 'presence:heartbeat':
    case 'presence:query':
      return true;
    default:
      return false;
  }
}

export function assertPresenceAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: PresenceAction,
): void {
  if (!authorizePresenceAction(actor, action)) {
    throw new PresenceDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: PRESENCE_MESSAGES.notFound,
    });
  }
}

/**
 * Luật cưỡng chế Đối xứng & Chống theo dõi 100% phía Server:
 * - Nếu người xem tắt `showActiveStatus` HOẶC người được xem tắt `showActiveStatus` -> `false`.
 * - Chặn tuyệt đối khi có quan hệ Block ở bất kỳ chiều nào.
 * - Chỉ trả trạng thái cho đối tượng có kết nối hợp lệ (theo dõi lẫn nhau hoặc có hội thoại chính).
 */
export function canViewTargetPresence(ctx: PresenceVisibilityContext): boolean {
  if (!isActiveSocialTarget(ctx.viewer) || !isActiveSocialTarget(ctx.target)) {
    return false;
  }
  if (ctx.viewer.id === ctx.target.id) {
    return false;
  }
  if (!ctx.viewer.showActiveStatus || !ctx.target.showActiveStatus) {
    return false;
  }
  if (ctx.isBidirectionallyBlocked) {
    return false;
  }
  return ctx.isMutualFollow || ctx.hasPrimaryConversation;
}
