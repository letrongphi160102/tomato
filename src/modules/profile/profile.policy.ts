import 'server-only';

import type { UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { ProfileDomainError } from '@/modules/profile/profile.errors';
import { PROFILE_MESSAGES } from '@/modules/profile/profile.messages';

export type ProfileAction =
  'profile:read' | 'profile:search' | 'profile:update' | 'avatar:update' | 'avatar:delete';

export interface ProfilePolicyTarget {
  readonly targetUser?: Pick<UserRow, 'id' | 'status' | 'deletedAt'> | null;
}

function isActiveActor(
  actor: AuthenticatedPrincipal | null | undefined,
): actor is AuthenticatedPrincipal {
  if (!actor) {
    return false;
  }
  return (
    actor.user.status === 'active' &&
    actor.user.deletedAt === null &&
    actor.session.revokedAt === null &&
    actor.session.userId === actor.user.id
  );
}

function isActiveTargetUser(
  target: Pick<UserRow, 'id' | 'status' | 'deletedAt'> | null | undefined,
): target is Pick<UserRow, 'id' | 'status' | 'deletedAt'> {
  if (!target) {
    return false;
  }
  return target.status === 'active' && target.deletedAt === null;
}

/**
 * Tầng Policy ReBAC tập trung cho phân hệ Hồ sơ (Deny-by-default, fail-closed):
 * - Mọi hành động đọc/ghi đều phải đi qua hàm này.
 * - M7 sẽ mở rộng trực tiếp tại đây để kiểm tra quan hệ chặn 2 chiều (`blocks`) và tài khoản riêng tư (`is_private`).
 */
export function authorizeProfileAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: ProfileAction,
  resource: ProfilePolicyTarget = {},
): boolean {
  if (!isActiveActor(actor)) {
    return false;
  }

  switch (action) {
    case 'profile:search':
      return true;
    case 'profile:read':
      return isActiveTargetUser(resource.targetUser);
    case 'profile:update':
    case 'avatar:update':
    case 'avatar:delete':
      return isActiveTargetUser(resource.targetUser) && resource.targetUser.id === actor.user.id;
    default:
      return false;
  }
}

/**
 * Cưỡng chế quyền đọc hồ sơ: trả `404 Not Found` đồng nhất khi đối tượng không tồn tại,
 * không ở trạng thái hoạt động hoặc bị từ chối quyền truy cập (chống dò tài khoản / IDOR).
 */
export function assertCanReadProfile(
  actor: AuthenticatedPrincipal | null | undefined,
  targetUser: UserRow | null | undefined,
): asserts targetUser is UserRow {
  if (!authorizeProfileAction(actor, 'profile:read', { targetUser })) {
    throw new ProfileDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: PROFILE_MESSAGES.profileNotFound,
    });
  }
}

export function assertCanSearchProfiles(
  actor: AuthenticatedPrincipal | null | undefined,
): asserts actor is AuthenticatedPrincipal {
  if (!authorizeProfileAction(actor, 'profile:search')) {
    throw new ProfileDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: PROFILE_MESSAGES.profileNotFound,
    });
  }
}

export function assertCanModifyOwnProfile(
  actor: AuthenticatedPrincipal | null | undefined,
  action: 'profile:update' | 'avatar:update' | 'avatar:delete',
  targetUser: Pick<UserRow, 'id' | 'status' | 'deletedAt'> | null | undefined,
): asserts actor is AuthenticatedPrincipal {
  if (!authorizeProfileAction(actor, action, { targetUser })) {
    throw new ProfileDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: PROFILE_MESSAGES.profileNotFound,
    });
  }
}
