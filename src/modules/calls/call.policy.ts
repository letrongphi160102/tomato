import 'server-only';

import type {
  CallSessionRow,
  ConversationParticipantRow,
  ConversationRow,
  UserRow,
} from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { CallDomainError } from '@/modules/calls/call.errors';
import { CALL_MESSAGES } from '@/modules/calls/call.messages';
import {
  isActiveSocialActor,
  isActiveSocialTarget,
  isBidirectionallyBlocked,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

export type CallPolicyUser = Pick<UserRow, 'id' | 'status' | 'deletedAt'>;

export type CallAction = 'call:ice_servers' | 'call:create' | 'call:signal' | 'call:action';

export interface CallPolicyResource {
  readonly conversation?: Pick<ConversationRow, 'id' | 'publicId'> | null;
  readonly actorParticipant?: Pick<
    ConversationParticipantRow,
    'conversationId' | 'userId' | 'inboxState'
  > | null;
  readonly peerParticipant?: Pick<
    ConversationParticipantRow,
    'conversationId' | 'userId' | 'inboxState'
  > | null;
  readonly peerUser?: CallPolicyUser | null;
  readonly relationship?: SocialRelationshipSnapshot | null;
  readonly callSession?: Pick<
    CallSessionRow,
    'id' | 'conversationId' | 'callerId' | 'calleeId' | 'status'
  > | null;
}

/**
 * Lớp Policy ReBAC tập trung cho phân hệ Gọi Thoại/Video 1-1 (M12).
 * Nguyên tắc OWASP 2025: Deny-by-default, fail-closed, trả `404 NOT_FOUND` đồng nhất
 * khi người ngoài cuộc truy cập hoặc hai bên có quan hệ Block 2 chiều.
 */
export function authorizeCallAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: CallAction,
  resource: CallPolicyResource = {},
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }

  switch (action) {
    case 'call:ice_servers':
      return true;

    case 'call:create': {
      const conv = resource.conversation;
      const actorPart = resource.actorParticipant;
      const peerPart = resource.peerParticipant;
      const peer = resource.peerUser;
      const relationship = resource.relationship;

      if (!conv || !actorPart || !peerPart || !isActiveSocialTarget(peer) || !relationship) {
        return false;
      }
      if (
        actorPart.conversationId !== conv.id ||
        actorPart.userId !== actor.user.id ||
        peerPart.conversationId !== conv.id ||
        peerPart.userId !== peer.id ||
        peer.id === actor.user.id
      ) {
        return false;
      }
      if (isBidirectionallyBlocked(relationship)) {
        return false;
      }
      return true;
    }

    case 'call:signal':
    case 'call:action': {
      const session = resource.callSession;
      const peer = resource.peerUser;
      const relationship = resource.relationship;

      if (!session || !isActiveSocialTarget(peer) || !relationship) {
        return false;
      }
      const isParticipant =
        session.callerId === actor.user.id || session.calleeId === actor.user.id;
      if (!isParticipant) {
        return false;
      }
      const expectedPeerId =
        session.callerId === actor.user.id ? session.calleeId : session.callerId;
      if (peer.id !== expectedPeerId) {
        return false;
      }
      if (isBidirectionallyBlocked(relationship)) {
        return false;
      }
      return true;
    }

    default:
      return false;
  }
}

export function assertCallAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: CallAction,
  resource: CallPolicyResource = {},
): void {
  if (!authorizeCallAction(actor, action, resource)) {
    throw new CallDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: CALL_MESSAGES.notFound,
    });
  }
}
