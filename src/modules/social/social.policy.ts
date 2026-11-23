import 'server-only';

import type { FollowStatus, UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { SocialDomainError } from '@/modules/social/social.errors';
import { SOCIAL_MESSAGES } from '@/modules/social/social.messages';

export type SocialFollowStatus = 'none' | FollowStatus;

export type SocialPolicyTargetUser = Pick<UserRow, 'id' | 'status' | 'deletedAt' | 'isPrivate'>;

export interface SocialRelationshipSnapshot {
  readonly blockedByActor: boolean;
  readonly blockedByTarget: boolean;
  /** Trạng thái actor -> target (`'none' | 'requested' | 'following'`). */
  readonly actorFollowStatus: SocialFollowStatus;
  /** Trạng thái target -> actor (`'none' | 'requested' | 'following'`). */
  readonly targetFollowStatus: SocialFollowStatus;
}

export type SocialAction =
  | 'profile:view'
  | 'profile:view_connections'
  | 'social:follow'
  | 'social:unfollow'
  | 'social:follow_request:list'
  | 'social:follow_request:accept'
  | 'social:follow_request:decline'
  | 'social:follower:remove'
  | 'social:block:list'
  | 'social:block'
  | 'social:unblock'
  | 'privacy:read'
  | 'privacy:update';

export interface SocialPolicyResource {
  readonly targetUser?: SocialPolicyTargetUser | null;
  readonly relationship?: SocialRelationshipSnapshot | null;
}

export const EMPTY_SOCIAL_RELATIONSHIP: SocialRelationshipSnapshot = Object.freeze({
  blockedByActor: false,
  blockedByTarget: false,
  actorFollowStatus: 'none',
  targetFollowStatus: 'none',
});

export function isActiveSocialActor(
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

export function isActiveSocialTarget(
  target: Pick<UserRow, 'id' | 'status' | 'deletedAt'> | null | undefined,
): target is Pick<UserRow, 'id' | 'status' | 'deletedAt'> {
  if (!target) {
    return false;
  }
  return target.status === 'active' && target.deletedAt === null;
}

export function isBidirectionallyBlocked(
  relationship:
    Pick<SocialRelationshipSnapshot, 'blockedByActor' | 'blockedByTarget'> | null | undefined,
): boolean {
  if (!relationship) {
    // Fail-closed: thiếu thông tin chặn thì coi như không an toàn.
    return true;
  }
  return relationship.blockedByActor || relationship.blockedByTarget;
}

/**
 * Kiểm tra quyền xem đầy đủ hồ sơ & danh sách Người theo dõi / Đang theo dõi của tài khoản mục tiêu.
 * Chỉ chính chủ, tài khoản Công khai, hoặc người theo dõi đã được duyệt (`status = 'following'`) được phép.
 */
export function canViewTargetConnections(
  actorUserId: string,
  target: SocialPolicyTargetUser,
  relationship: SocialRelationshipSnapshot,
): boolean {
  if (actorUserId === target.id) {
    return true;
  }
  if (isBidirectionallyBlocked(relationship)) {
    return false;
  }
  if (!target.isPrivate) {
    return true;
  }
  return relationship.actorFollowStatus === 'following';
}

/**
 * Tầng Policy ReBAC tập trung cho phân hệ Mạng lưới Kết nối, Tài khoản Riêng tư & Chặn hai chiều.
 * Nguyên tắc bắt buộc: Deny-by-default, fail-closed.
 */
export function authorizeSocialAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: SocialAction,
  resource: SocialPolicyResource = {},
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }

  const target = resource.targetUser;
  const relationship = resource.relationship;

  switch (action) {
    case 'social:follow_request:list':
    case 'social:block:list':
    case 'privacy:read':
    case 'privacy:update': {
      if (target !== undefined) {
        return isActiveSocialTarget(target) && target.id === actor.user.id;
      }
      return true;
    }

    case 'profile:view': {
      if (!isActiveSocialTarget(target)) {
        return false;
      }
      if (target.id === actor.user.id) {
        return true;
      }
      if (!relationship) {
        return false;
      }
      return !isBidirectionallyBlocked(relationship);
    }

    case 'profile:view_connections': {
      if (!isActiveSocialTarget(target)) {
        return false;
      }
      if (target.id === actor.user.id) {
        return true;
      }
      if (!relationship) {
        return false;
      }
      return canViewTargetConnections(actor.user.id, target, relationship);
    }

    case 'social:follow':
    case 'social:unfollow':
    case 'social:follow_request:accept':
    case 'social:follow_request:decline':
    case 'social:follower:remove': {
      if (!isActiveSocialTarget(target) || target.id === actor.user.id || !relationship) {
        return false;
      }
      return !isBidirectionallyBlocked(relationship);
    }

    case 'social:block': {
      if (!isActiveSocialTarget(target) || target.id === actor.user.id || !relationship) {
        return false;
      }
      // Nếu target đã chặn actor trước và actor chưa chặn target -> từ chối 404 (chống dò tài khoản đã chặn mình).
      if (relationship.blockedByTarget && !relationship.blockedByActor) {
        return false;
      }
      return true;
    }

    case 'social:unblock': {
      if (!target || target.id === actor.user.id || !relationship) {
        return false;
      }
      // Luôn cho phép gỡ bản ghi chặn của chính actor kể cả khi tài khoản kia đang bị khóa/đình chỉ.
      if (relationship.blockedByActor) {
        return true;
      }
      // Nếu chưa chặn: chỉ cho idempotent khi target đang hoạt động và chưa chặn ngược actor.
      return isActiveSocialTarget(target) && !relationship.blockedByTarget;
    }

    default:
      return false;
  }
}

/**
 * Cưỡng chế quyền truy cập tập trung: luôn ném `404 Not Found` đồng nhất khi bị chặn hoặc không đủ quyền.
 */
export function assertSocialAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: SocialAction,
  resource: SocialPolicyResource = {},
): void {
  if (!authorizeSocialAction(actor, action, resource)) {
    throw new SocialDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: SOCIAL_MESSAGES.notFound,
    });
  }
}
