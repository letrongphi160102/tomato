import 'server-only';

import type { UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { NotificationDomainError } from '@/modules/notifications/notification.errors';
import { NOTIFICATION_MESSAGES } from '@/modules/notifications/notification.messages';
import {
  isActiveSocialActor,
  isActiveSocialTarget,
  isBidirectionallyBlocked,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

export type NotificationAction =
  'notification:list' | 'notification:mark_read' | 'notification:delete' | 'notification:emit';

export interface NotificationPolicyResource {
  readonly recipientUser?: Pick<UserRow, 'id' | 'status' | 'deletedAt'> | null;
  readonly notificationRecipientId?: string | null;
  readonly relationship?: SocialRelationshipSnapshot | null;
}

/**
 * Tầng Policy ReBAC tập trung cho Thông báo (Deny-by-default, fail-closed).
 */
export function authorizeNotificationAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: NotificationAction,
  resource: NotificationPolicyResource = {},
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }

  switch (action) {
    case 'notification:list':
    case 'notification:mark_read': {
      if (resource.recipientUser !== undefined) {
        return (
          isActiveSocialTarget(resource.recipientUser) &&
          resource.recipientUser.id === actor.user.id
        );
      }
      return true;
    }

    case 'notification:delete': {
      if (resource.notificationRecipientId !== undefined) {
        return (
          typeof resource.notificationRecipientId === 'string' &&
          resource.notificationRecipientId === actor.user.id
        );
      }
      if (resource.recipientUser !== undefined) {
        return (
          isActiveSocialTarget(resource.recipientUser) &&
          resource.recipientUser.id === actor.user.id
        );
      }
      return true;
    }

    case 'notification:emit': {
      const recipient = resource.recipientUser;
      const relationship = resource.relationship;
      if (!isActiveSocialTarget(recipient) || recipient.id === actor.user.id || !relationship) {
        return false;
      }
      return !isBidirectionallyBlocked(relationship);
    }

    default:
      return false;
  }
}

export function assertNotificationAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: NotificationAction,
  resource: NotificationPolicyResource = {},
): void {
  if (!authorizeNotificationAction(actor, action, resource)) {
    throw new NotificationDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: NOTIFICATION_MESSAGES.notFound,
    });
  }
}
