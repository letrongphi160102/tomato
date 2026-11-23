import 'server-only';

import type { ConversationParticipantRow, ConversationRow, UserRow } from '@/core/db/schema';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { ChatDomainError } from '@/modules/chat/chat.errors';
import { CHAT_MESSAGES } from '@/modules/chat/chat.messages';
import {
  isActiveSocialActor,
  isActiveSocialTarget,
  isBidirectionallyBlocked,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

export type ChatPolicyUser = Pick<UserRow, 'id' | 'status' | 'deletedAt' | 'isPrivate'>;

export type ChatAction =
  | 'e2ee:device:register'
  | 'e2ee:keys:read'
  | 'e2ee:backup:read'
  | 'e2ee:backup:write'
  | 'chat:conversation:list'
  | 'chat:conversation:create_or_get'
  | 'chat:conversation:view'
  | 'chat:conversation:read'
  | 'chat:conversation:accept'
  | 'chat:conversation:decline'
  | 'chat:message:list'
  | 'chat:message:send';

export interface SymmetricReadReceiptContext {
  readonly actorShowReadReceipts: boolean;
  readonly peerShowReadReceipts: boolean;
  readonly actorInboxState: ConversationParticipantRow['inboxState'];
  readonly peerInboxState: ConversationParticipantRow['inboxState'];
  readonly relationship: SocialRelationshipSnapshot | null | undefined;
}

/**
 * Cưỡng chế đối xứng tuyệt đối cho Trạng thái "Đã xem" (Read Receipts):
 * Chỉ được phép trả `peerLastReadSeq` hoặc phát sự kiện `chat.conversation.read` cho đối phương
 * khi CẢ HAI người đều bật `show_read_receipts = true`, hội thoại thuộc `primary` ở cả 2 phía
 * và không có quan hệ chặn 2 chiều.
 */
export function canExposeSymmetricReadReceipt(ctx: SymmetricReadReceiptContext): boolean {
  if (!ctx.actorShowReadReceipts || !ctx.peerShowReadReceipts) {
    return false;
  }
  if (ctx.actorInboxState !== 'primary' || ctx.peerInboxState !== 'primary') {
    return false;
  }
  if (!ctx.relationship || isBidirectionallyBlocked(ctx.relationship)) {
    return false;
  }
  return true;
}

export interface ChatPolicyResource {
  readonly targetUser?: ChatPolicyUser | null;
  readonly peerUser?: ChatPolicyUser | null;
  readonly relationship?: SocialRelationshipSnapshot | null;
  readonly conversation?: Pick<ConversationRow, 'id' | 'publicId'> | null;
  readonly actorParticipant?: Pick<
    ConversationParticipantRow,
    'conversationId' | 'userId' | 'inboxState'
  > | null;
}

/**
 * Tầng Policy ReBAC tập trung cho phân hệ Nhắn tin 1-1 Bảo mật & Tin nhắn đang chờ (M9).
 * Nguyên tắc bắt buộc: Deny-by-default, fail-closed, trả 404 đồng nhất khi bị chặn hoặc không có quyền.
 */
export function authorizeChatAction(
  actor: AuthenticatedPrincipal | null | undefined,
  action: ChatAction,
  resource: ChatPolicyResource = {},
): boolean {
  if (!isActiveSocialActor(actor)) {
    return false;
  }

  switch (action) {
    case 'e2ee:device:register':
    case 'e2ee:backup:read':
    case 'e2ee:backup:write':
    case 'chat:conversation:list': {
      return true;
    }

    case 'e2ee:keys:read': {
      const target = resource.targetUser;
      if (!isActiveSocialTarget(target)) {
        return false;
      }
      if (target.id === actor.user.id) {
        return true;
      }
      if (!resource.relationship) {
        return false;
      }
      return !isBidirectionallyBlocked(resource.relationship);
    }

    case 'chat:conversation:create_or_get': {
      const target = resource.targetUser;
      if (!isActiveSocialTarget(target) || target.id === actor.user.id) {
        return false;
      }
      if (!resource.relationship) {
        return false;
      }
      return !isBidirectionallyBlocked(resource.relationship);
    }

    case 'chat:conversation:view':
    case 'chat:conversation:read':
    case 'chat:conversation:accept':
    case 'chat:conversation:decline':
    case 'chat:message:list':
    case 'chat:message:send': {
      const conv = resource.conversation;
      const participant = resource.actorParticipant;
      const peer = resource.peerUser;
      const relationship = resource.relationship;

      if (!conv || !participant || !isActiveSocialTarget(peer) || !relationship) {
        return false;
      }
      if (participant.conversationId !== conv.id || participant.userId !== actor.user.id) {
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

export function assertChatAuthorized(
  actor: AuthenticatedPrincipal | null | undefined,
  action: ChatAction,
  resource: ChatPolicyResource = {},
): void {
  if (!authorizeChatAction(actor, action, resource)) {
    throw new ChatDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: CHAT_MESSAGES.notFound,
    });
  }
}
