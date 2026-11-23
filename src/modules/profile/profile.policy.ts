import 'server-only';

import type { UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { ProfileDomainError } from '@/modules/profile/profile.errors';
import { PROFILE_MESSAGES } from '@/modules/profile/profile.messages';
import {
  authorizeSocialAction,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

export type ProfileAction =
  'profile:read' | 'profile:search' | 'profile:update' | 'avatar:update' | 'avatar:delete';

export interface ProfilePolicyTarget {
  readonly targetUser?:
    | (Pick<UserRow, 'id' | 'status' | 'deletedAt'> & {
        readonly isPrivate?: boolean;
      })
    | null;
  readonly relationship?: SocialRelationshipSnapshot | null;
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
 * - Khi có `relationship` (M7), ủy quyền trực tiếp sang `social.policy.ts` để cưỡng chế chặn 2 chiều.
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
    case 'profile:read': {
      if (!isActiveTargetUser(resource.targetUser)) {
        return false;
      }
      if (resource.targetUser.id === actor.user.id) {
        return true;
      }
      if (resource.relationship !== undefined) {
        return authorizeSocialAction(actor, 'profile:view', {
          targetUser: {
            id: resource.targetUser.id,
            status: resource.targetUser.status,
            deletedAt: resource.targetUser.deletedAt,
            isPrivate: resource.targetUser.isPrivate ?? false,
          },
          relationship: resource.relationship,
        });
      }
      return true;
    }
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
 * không ở trạng thái hoạt động, bị chặn 2 chiều hoặc bị từ chối quyền truy cập (chống dò tài khoản / IDOR).
 */
export function assertCanReadProfile(
  actor: AuthenticatedPrincipal | null | undefined,
  targetUser: UserRow | null | undefined,
  relationship?: SocialRelationshipSnapshot | null,
): asserts targetUser is UserRow {
  if (!authorizeProfileAction(actor, 'profile:read', { targetUser, relationship })) {
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
