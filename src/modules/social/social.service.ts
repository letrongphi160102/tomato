import 'server-only';

import { SOCIAL_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import {
  getNotificationService,
  type NotificationService,
  type PendingRealtimeDispatch,
} from '@/modules/notifications';
import { getPresenceService, type PresenceService } from '@/modules/presence';
import { SocialDomainError } from '@/modules/social/social.errors';
import { SOCIAL_MESSAGES } from '@/modules/social/social.messages';
import {
  assertSocialAuthorized,
  isActiveSocialTarget,
  type SocialFollowStatus,
} from '@/modules/social/social.policy';
import { SocialRepository } from '@/modules/social/social.repository';
import {
  encodeSocialCursor,
  publicIdRouteParamSchema,
  socialConnectionListQuerySchema,
  socialSimpleListQuerySchema,
  updatePrivacyInputSchema,
} from '@/modules/social/social.schemas';

export const PRIVACY_PENDING_BATCH_SIZE = 100;

/**
 * DTO allowlist cho mỗi dòng trong danh sách Người theo dõi / Đang theo dõi.
 * Tuyệt đối không lộ `id` (UUIDv7), `avatarStorageKey` hay `email`.
 */
export interface SocialUserListItemDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly followStatus: SocialFollowStatus;
  /** Chỉ `true` khi đối phương đang có `status = 'following'` với người xem. */
  readonly followedBy: boolean;
  readonly isOwnProfile: boolean;
}

export interface SocialFollowRequestItemDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly requestedAt: string;
}

export interface SocialBlockedUserItemDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly blockedAt: string;
}

export interface FollowMutationResult {
  readonly followStatus: SocialFollowStatus;
  readonly followersCount: number;
  readonly followingCount: number;
  readonly message: string;
}

export interface FollowRequestDecisionResult {
  readonly followStatus: SocialFollowStatus;
  readonly followersCount?: number;
  readonly message: string;
}

export interface RemoveFollowerResult {
  readonly removed: boolean;
  readonly followersCount: number;
  readonly message: string;
}

export interface BlockMutationResult {
  readonly blocked: boolean;
  readonly message: string;
}

export interface PrivacySettingsDto {
  readonly isPrivate: boolean;
  readonly showActiveStatus: boolean;
  readonly showReadReceipts: boolean;
  readonly pendingFollowRequestsCount: number;
}

export interface GetPrivacySettingsResult {
  readonly privacy: PrivacySettingsDto;
}

export interface UpdatePrivacySettingsResult {
  readonly privacy: PrivacySettingsDto;
  readonly acceptedRequestsCount: number;
  readonly followersCount: number;
  readonly message: string;
}

export interface PaginatedSocialListResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface SocialServiceDependencies {
  readonly repository?: SocialRepository;
  readonly rateLimiter?: RateLimiter;
  readonly auditLogService?: AuditLogService;
  readonly notificationService?: NotificationService | null;
  readonly presenceService?: Pick<PresenceService, 'clearUserPresence'> | null;
  readonly now?: () => Date;
  readonly privacyBatchSize?: number;
}

function parsePublicIdOrThrowNotFound(rawPublicId: string): string {
  const parsed = publicIdRouteParamSchema.safeParse(rawPublicId);
  if (!parsed.success) {
    throw new SocialDomainError({
      status: 404,
      code: 'NOT_FOUND',
      message: SOCIAL_MESSAGES.notFound,
    });
  }
  return parsed.data;
}

export class SocialService {
  private readonly repository: SocialRepository;
  private readonly rateLimiter: RateLimiter;
  private readonly auditLogService: AuditLogService;
  private readonly notificationService: NotificationService | null;
  private readonly presenceService: Pick<PresenceService, 'clearUserPresence'> | null;
  private readonly now: () => Date;
  private readonly privacyBatchSize: number;

  constructor(deps: SocialServiceDependencies = {}) {
    this.repository = deps.repository ?? new SocialRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.notificationService =
      deps.notificationService !== undefined
        ? deps.notificationService
        : deps.repository === undefined
          ? getNotificationService()
          : null;
    this.presenceService =
      deps.presenceService !== undefined
        ? deps.presenceService
        : deps.repository === undefined
          ? getPresenceService()
          : null;
    this.now = deps.now ?? (() => new Date());
    this.privacyBatchSize = Math.max(1, deps.privacyBatchSize ?? PRIVACY_PENDING_BATCH_SIZE);
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof SOCIAL_RATE_LIMITS)[keyof typeof SOCIAL_RATE_LIMITS],
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new SocialDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: SOCIAL_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  /**
   * State machine Follow (`none -> requested | following`):
   * - Idempotent, khóa cặp `{actor, target}` theo `id ASC FOR UPDATE`, cập nhật bộ đếm đồng bộ trong 1 transaction.
   * - Dùng chung hạn mức 30 lần/giờ/user với Unfollow.
   */
  async followUser(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
  ): Promise<FollowMutationResult> {
    assertSocialAuthorized(actor, 'privacy:read');
    await this.consumeRateLimitOrThrow(
      `social:follow:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.followActionByUser,
    );

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetPublicId);
    const targetCandidate = await this.repository.findUserByPublicId(targetPublicId);
    if (!targetCandidate) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    if (targetCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.cannotFollowSelf,
      });
    }

    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const result = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, targetCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedTarget = lockedUsers.get(targetCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedTarget)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:follow', {
        targetUser: lockedTarget,
        relationship,
      });

      const existing = await this.repository.findFollowRow(lockedActor.id, lockedTarget.id, tx);
      if (existing) {
        if (existing.status === 'following') {
          return {
            followStatus: 'following' as const,
            followersCount: lockedTarget.followersCount,
            followingCount: lockedActor.followingCount,
            message: SOCIAL_MESSAGES.followed,
          };
        }

        // Trạng thái hiện tại là `requested`: nếu target vẫn riêng tư thì idempotent;
        // nếu target đã chuyển sang công khai thì nâng cấp lên `following` và cộng bộ đếm.
        if (lockedTarget.isPrivate) {
          return {
            followStatus: 'requested' as const,
            followersCount: lockedTarget.followersCount,
            followingCount: lockedActor.followingCount,
            message: SOCIAL_MESSAGES.followRequested,
          };
        }

        const upgraded = await this.repository.upgradePendingFollowToFollowing(
          lockedActor.id,
          lockedTarget.id,
          currentTime,
          tx,
        );
        if (upgraded) {
          const [updatedActor, updatedTarget] = await Promise.all([
            this.repository.adjustUserFollowCounters(
              lockedActor.id,
              { followingDelta: 1 },
              currentTime,
              tx,
            ),
            this.repository.adjustUserFollowCounters(
              lockedTarget.id,
              { followersDelta: 1 },
              currentTime,
              tx,
            ),
          ]);
          if (this.notificationService) {
            pendingDispatches.push(
              await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
                recipientId: lockedTarget.id,
                recipientPublicId: lockedTarget.publicId,
                actorIds: [lockedActor.id],
              }),
            );
            pendingDispatches.push(
              await this.notificationService.recordNotificationInTx(tx, {
                recipient: lockedTarget,
                actor: lockedActor,
                type: 'new_follower',
                entityPublicId: lockedActor.publicId,
                now: currentTime,
              }),
            );
          }
          return {
            followStatus: 'following' as const,
            followersCount: updatedTarget?.followersCount ?? lockedTarget.followersCount + 1,
            followingCount: updatedActor?.followingCount ?? lockedActor.followingCount + 1,
            message: SOCIAL_MESSAGES.followed,
          };
        }
      }

      const nextStatus = lockedTarget.isPrivate ? 'requested' : 'following';
      await this.repository.insertFollowRow(
        {
          followerId: lockedActor.id,
          followeeId: lockedTarget.id,
          status: nextStatus,
          now: currentTime,
        },
        tx,
      );

      if (nextStatus === 'following') {
        const [updatedActor, updatedTarget] = await Promise.all([
          this.repository.adjustUserFollowCounters(
            lockedActor.id,
            { followingDelta: 1 },
            currentTime,
            tx,
          ),
          this.repository.adjustUserFollowCounters(
            lockedTarget.id,
            { followersDelta: 1 },
            currentTime,
            tx,
          ),
        ]);
        if (this.notificationService) {
          pendingDispatches.push(
            await this.notificationService.recordNotificationInTx(tx, {
              recipient: lockedTarget,
              actor: lockedActor,
              type: 'new_follower',
              entityPublicId: lockedActor.publicId,
              now: currentTime,
            }),
          );
        }
        return {
          followStatus: 'following' as const,
          followersCount: updatedTarget?.followersCount ?? lockedTarget.followersCount + 1,
          followingCount: updatedActor?.followingCount ?? lockedActor.followingCount + 1,
          message: SOCIAL_MESSAGES.followed,
        };
      }

      if (this.notificationService) {
        pendingDispatches.push(
          await this.notificationService.recordNotificationInTx(tx, {
            recipient: lockedTarget,
            actor: lockedActor,
            type: 'follow_request',
            entityPublicId: lockedActor.publicId,
            now: currentTime,
          }),
        );
      }

      return {
        followStatus: 'requested' as const,
        followersCount: lockedTarget.followersCount,
        followingCount: lockedActor.followingCount,
        message: SOCIAL_MESSAGES.followRequested,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    return result;
  }

  /**
   * Hủy theo dõi hoặc hủy yêu cầu theo dõi đang chờ (`following | requested -> none`, idempotent).
   */
  async unfollowUser(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
  ): Promise<FollowMutationResult> {
    assertSocialAuthorized(actor, 'privacy:read');
    await this.consumeRateLimitOrThrow(
      `social:follow:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.followActionByUser,
    );

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetPublicId);
    const targetCandidate = await this.repository.findUserByPublicId(targetPublicId);
    if (!targetCandidate) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    if (targetCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.invalidSelfAction,
      });
    }

    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const result = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, targetCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedTarget = lockedUsers.get(targetCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedTarget)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:unfollow', {
        targetUser: lockedTarget,
        relationship,
      });

      const deletedStatus = await this.repository.deleteFollowRow(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );

      if (deletedStatus === 'following') {
        const [updatedActor, updatedTarget] = await Promise.all([
          this.repository.adjustUserFollowCounters(
            lockedActor.id,
            { followingDelta: -1 },
            currentTime,
            tx,
          ),
          this.repository.adjustUserFollowCounters(
            lockedTarget.id,
            { followersDelta: -1 },
            currentTime,
            tx,
          ),
        ]);
        return {
          followStatus: 'none' as const,
          followersCount:
            updatedTarget?.followersCount ?? Math.max(0, lockedTarget.followersCount - 1),
          followingCount:
            updatedActor?.followingCount ?? Math.max(0, lockedActor.followingCount - 1),
          message: SOCIAL_MESSAGES.unfollowed,
        };
      }

      if (deletedStatus === 'requested' && this.notificationService) {
        pendingDispatches.push(
          await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
            recipientId: lockedTarget.id,
            recipientPublicId: lockedTarget.publicId,
            actorIds: [lockedActor.id],
          }),
        );
      }

      return {
        followStatus: 'none' as const,
        followersCount: lockedTarget.followersCount,
        followingCount: lockedActor.followingCount,
        message:
          deletedStatus === 'requested'
            ? SOCIAL_MESSAGES.followRequestCancelled
            : SOCIAL_MESSAGES.unfollowed,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    return result;
  }

  async listFollowRequests(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<PaginatedSocialListResult<SocialFollowRequestItemDto>> {
    assertSocialAuthorized(actor, 'social:follow_request:list');
    await this.consumeRateLimitOrThrow(
      `social:list:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.socialListReadByUser,
    );

    const parsed = socialSimpleListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const rows = await this.repository.listFollowRequests({
      actorUserId: actor.user.id,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });

    const hasMore = rows.length > parsed.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => ({
        public_id: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        isPrivate: row.isPrivate,
        requestedAt: row.requestedAt.toISOString(),
      })),
      nextCursor:
        hasMore && lastRow
          ? encodeSocialCursor({
              createdAtIso: lastRow.cursorCreatedAtIso,
              publicId: lastRow.publicId,
            })
          : null,
    };
  }

  async acceptFollowRequest(
    actor: AuthenticatedPrincipal,
    rawRequesterPublicId: string,
  ): Promise<FollowRequestDecisionResult> {
    assertSocialAuthorized(actor, 'social:follow_request:list');
    await this.consumeRateLimitOrThrow(
      `social:request_action:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.followRequestActionByUser,
    );

    const requesterPublicId = parsePublicIdOrThrowNotFound(rawRequesterPublicId);
    const requesterCandidate = await this.repository.findUserByPublicId(requesterPublicId);
    if (!requesterCandidate || requesterCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const result = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, requesterCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedRequester = lockedUsers.get(requesterCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedRequester)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedRequester.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:follow_request:accept', {
        targetUser: lockedRequester,
        relationship,
      });

      const upgraded = await this.repository.upgradePendingFollowToFollowing(
        lockedRequester.id,
        lockedActor.id,
        currentTime,
        tx,
      );
      if (!upgraded) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const [, updatedActor] = await Promise.all([
        this.repository.adjustUserFollowCounters(
          lockedRequester.id,
          { followingDelta: 1 },
          currentTime,
          tx,
        ),
        this.repository.adjustUserFollowCounters(
          lockedActor.id,
          { followersDelta: 1 },
          currentTime,
          tx,
        ),
      ]);

      if (this.notificationService) {
        pendingDispatches.push(
          await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
            recipientId: lockedActor.id,
            recipientPublicId: lockedActor.publicId,
            actorIds: [lockedRequester.id],
          }),
        );
        pendingDispatches.push(
          await this.notificationService.recordNotificationInTx(tx, {
            recipient: lockedRequester,
            actor: lockedActor,
            type: 'follow_accepted',
            entityPublicId: lockedActor.publicId,
            now: currentTime,
          }),
        );
      }

      return {
        followStatus: 'following' as const,
        followersCount: updatedActor?.followersCount ?? lockedActor.followersCount + 1,
        message: SOCIAL_MESSAGES.followRequestAccepted,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    return result;
  }

  async declineFollowRequest(
    actor: AuthenticatedPrincipal,
    rawRequesterPublicId: string,
  ): Promise<FollowRequestDecisionResult> {
    assertSocialAuthorized(actor, 'social:follow_request:list');
    await this.consumeRateLimitOrThrow(
      `social:request_action:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.followRequestActionByUser,
    );

    const requesterPublicId = parsePublicIdOrThrowNotFound(rawRequesterPublicId);
    const requesterCandidate = await this.repository.findUserByPublicId(requesterPublicId);
    if (!requesterCandidate || requesterCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const result = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, requesterCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedRequester = lockedUsers.get(requesterCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedRequester)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedRequester.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:follow_request:decline', {
        targetUser: lockedRequester,
        relationship,
      });

      const deletedStatus = await this.repository.deleteFollowRow(
        lockedRequester.id,
        lockedActor.id,
        tx,
        'requested',
      );
      if (!deletedStatus) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      if (this.notificationService) {
        // Chỉ gỡ yêu cầu khỏi chuông của người từ chối; không gửi thông báo cho người bị từ chối.
        pendingDispatches.push(
          await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
            recipientId: lockedActor.id,
            recipientPublicId: lockedActor.publicId,
            actorIds: [lockedRequester.id],
          }),
        );
      }

      return {
        followStatus: 'none' as const,
        message: SOCIAL_MESSAGES.followRequestDeclined,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    return result;
  }

  async removeFollower(
    actor: AuthenticatedPrincipal,
    rawFollowerPublicId: string,
  ): Promise<RemoveFollowerResult> {
    assertSocialAuthorized(actor, 'privacy:read');
    await this.consumeRateLimitOrThrow(
      `social:request_action:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.followRequestActionByUser,
    );

    const followerPublicId = parsePublicIdOrThrowNotFound(rawFollowerPublicId);
    const followerCandidate = await this.repository.findUserByPublicId(followerPublicId);
    if (!followerCandidate) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    if (followerCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.invalidSelfAction,
      });
    }

    const currentTime = this.now();

    return this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, followerCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedFollower = lockedUsers.get(followerCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedFollower)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedFollower.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:follower:remove', {
        targetUser: lockedFollower,
        relationship,
      });

      const deletedStatus = await this.repository.deleteFollowRow(
        lockedFollower.id,
        lockedActor.id,
        tx,
        'following',
      );
      if (deletedStatus !== 'following') {
        return {
          removed: false,
          followersCount: lockedActor.followersCount,
          message: SOCIAL_MESSAGES.followerRemoved,
        };
      }

      const [, updatedActor] = await Promise.all([
        this.repository.adjustUserFollowCounters(
          lockedFollower.id,
          { followingDelta: -1 },
          currentTime,
          tx,
        ),
        this.repository.adjustUserFollowCounters(
          lockedActor.id,
          { followersDelta: -1 },
          currentTime,
          tx,
        ),
      ]);

      return {
        removed: true,
        followersCount: updatedActor?.followersCount ?? Math.max(0, lockedActor.followersCount - 1),
        message: SOCIAL_MESSAGES.followerRemoved,
      };
    });
  }

  async listFollowers(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<PaginatedSocialListResult<SocialUserListItemDto>> {
    return this.listConnections('followers', actor, rawTargetPublicId, rawQuery);
  }

  async listFollowing(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<PaginatedSocialListResult<SocialUserListItemDto>> {
    return this.listConnections('following', actor, rawTargetPublicId, rawQuery);
  }

  private async listConnections(
    direction: 'followers' | 'following',
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<PaginatedSocialListResult<SocialUserListItemDto>> {
    assertSocialAuthorized(actor, 'privacy:read');
    await this.consumeRateLimitOrThrow(
      `social:list:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.socialListReadByUser,
    );

    const parsedQuery = socialConnectionListQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedQuery.error),
      });
    }

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetPublicId);
    const targetUser = await this.repository.findUserByPublicId(targetPublicId);
    const relationship = targetUser
      ? await this.repository.getRelationshipSnapshot(actor.user.id, targetUser.id)
      : null;

    assertSocialAuthorized(actor, 'profile:view_connections', {
      targetUser,
      relationship,
    });

    const rows =
      direction === 'followers'
        ? await this.repository.listFollowers({
            targetUserId: targetUser!.id,
            viewerUserId: actor.user.id,
            limit: parsedQuery.data.limit,
            cursor: parsedQuery.data.cursor,
            query: parsedQuery.data.q,
          })
        : await this.repository.listFollowing({
            targetUserId: targetUser!.id,
            viewerUserId: actor.user.id,
            limit: parsedQuery.data.limit,
            cursor: parsedQuery.data.cursor,
            query: parsedQuery.data.q,
          });

    const hasMore = rows.length > parsedQuery.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsedQuery.data.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => ({
        public_id: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        isPrivate: row.isPrivate,
        followStatus: row.viewerFollowStatus,
        followedBy: row.followedBy,
        isOwnProfile: row.isSelf,
      })),
      nextCursor:
        hasMore && lastRow
          ? encodeSocialCursor({
              createdAtIso: lastRow.cursorCreatedAtIso,
              publicId: lastRow.publicId,
            })
          : null,
    };
  }

  async listBlockedUsers(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
    options: { readonly skipRateLimit?: boolean } = {},
  ): Promise<PaginatedSocialListResult<SocialBlockedUserItemDto>> {
    assertSocialAuthorized(actor, 'social:block:list');
    if (!options.skipRateLimit) {
      await this.consumeRateLimitOrThrow(
        `social:list:user:${actor.user.id}`,
        SOCIAL_RATE_LIMITS.socialListReadByUser,
      );
    }

    const parsed = socialSimpleListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const rows = await this.repository.listBlockedUsers({
      actorUserId: actor.user.id,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });

    const hasMore = rows.length > parsed.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => ({
        public_id: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        blockedAt: row.blockedAt.toISOString(),
      })),
      nextCursor:
        hasMore && lastRow
          ? encodeSocialCursor({
              createdAtIso: lastRow.cursorCreatedAtIso,
              publicId: lastRow.publicId,
            })
          : null,
    };
  }

  /**
   * Chặn người dùng hai chiều:
   * - Trong cùng 1 transaction (đã khóa `{actor, target}` theo `id ASC FOR UPDATE`):
   *   1. Chèn bản ghi chặn `blocks(actor, target)` (idempotent).
   *   2. Xóa mọi `follows` và `follow requests` ở CẢ HAI CHIỀU.
   *   3. Cập nhật lại đồng bộ `followers_count`/`following_count` cho cả hai bên.
   *   4. Không gửi bất kỳ thông báo nào cho người bị chặn.
   */
  async blockUser(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
    context: RequestClientContext,
  ): Promise<BlockMutationResult> {
    assertSocialAuthorized(actor, 'social:block:list');
    await this.consumeRateLimitOrThrow(
      `social:block:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.blockActionByUser,
    );

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetPublicId);
    const targetCandidate = await this.repository.findUserByPublicId(targetPublicId);
    if (!targetCandidate) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    if (targetCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.cannotBlockSelf,
      });
    }

    const currentTime = this.now();
    const pendingDispatches: (PendingRealtimeDispatch | null)[] = [];

    const result = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, targetCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedTarget = lockedUsers.get(targetCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !isActiveSocialTarget(lockedTarget)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:block', {
        targetUser: lockedTarget,
        relationship,
      });

      const inserted = await this.repository.insertBlockIfAbsent(
        lockedActor.id,
        lockedTarget.id,
        currentTime,
        tx,
      );

      // Luôn dọn sạch mọi quan hệ follow/request cả hai chiều để đảm bảo bất biến.
      const deletedFollows = await this.repository.deleteFollowsBothDirections(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );

      // Xóa sạch toàn bộ thông báo hai chiều giữa A và B trong DB; im lặng tuyệt đối với B.
      if (this.notificationService) {
        pendingDispatches.push(
          await this.notificationService.purgeNotificationsOnBlockInTx(tx, {
            blockerId: lockedActor.id,
            blockerPublicId: lockedActor.publicId,
            blockedId: lockedTarget.id,
          }),
        );
      }

      let actorFollowersDelta = 0;
      let actorFollowingDelta = 0;
      let targetFollowersDelta = 0;
      let targetFollowingDelta = 0;

      for (const row of deletedFollows) {
        if (row.status !== 'following') {
          continue;
        }
        if (row.followerId === lockedActor.id && row.followeeId === lockedTarget.id) {
          actorFollowingDelta -= 1;
          targetFollowersDelta -= 1;
        } else if (row.followerId === lockedTarget.id && row.followeeId === lockedActor.id) {
          targetFollowingDelta -= 1;
          actorFollowersDelta -= 1;
        }
      }

      if (actorFollowersDelta !== 0 || actorFollowingDelta !== 0) {
        await this.repository.adjustUserFollowCounters(
          lockedActor.id,
          { followersDelta: actorFollowersDelta, followingDelta: actorFollowingDelta },
          currentTime,
          tx,
        );
      }

      if (targetFollowersDelta !== 0 || targetFollowingDelta !== 0) {
        await this.repository.adjustUserFollowCounters(
          lockedTarget.id,
          { followersDelta: targetFollowersDelta, followingDelta: targetFollowingDelta },
          currentTime,
          tx,
        );
      }

      if (inserted) {
        await this.auditLogService.record(
          {
            userId: lockedActor.id,
            action: 'USER_BLOCKED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              targetPublicId: lockedTarget.publicId,
            },
          },
          tx,
        );
      }

      return {
        blocked: true,
        message: SOCIAL_MESSAGES.userBlocked,
      };
    });

    if (this.notificationService && pendingDispatches.length > 0) {
      await this.notificationService.dispatchRealtimeEvents(pendingDispatches);
    }

    return result;
  }

  /**
   * Bỏ chặn tài khoản:
   * - Luôn cho phép gỡ bản ghi chặn hiện có ngay cả khi tài khoản kia đang `locked`/`suspended` (tránh kẹt danh sách chặn).
   * - Không bao giờ tự khôi phục quan hệ theo dõi trước đây.
   */
  async unblockUser(
    actor: AuthenticatedPrincipal,
    rawTargetPublicId: string,
    context: RequestClientContext,
  ): Promise<BlockMutationResult> {
    assertSocialAuthorized(actor, 'social:block:list');
    await this.consumeRateLimitOrThrow(
      `social:block:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.blockActionByUser,
    );

    const targetPublicId = parsePublicIdOrThrowNotFound(rawTargetPublicId);
    const targetCandidate = await this.repository.findUserByPublicId(targetPublicId);
    if (!targetCandidate) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    if (targetCandidate.id === actor.user.id) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.invalidSelfAction,
      });
    }

    return this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
        [actor.user.id, targetCandidate.id],
        tx,
      );
      const lockedActor = lockedUsers.get(actor.user.id);
      const lockedTarget = lockedUsers.get(targetCandidate.id);

      if (!isActiveSocialTarget(lockedActor) || !lockedTarget) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const relationship = await this.repository.getRelationshipSnapshot(
        lockedActor.id,
        lockedTarget.id,
        tx,
      );
      assertSocialAuthorized(actor, 'social:unblock', {
        targetUser: lockedTarget,
        relationship,
      });

      const deleted = await this.repository.deleteBlockRow(lockedActor.id, lockedTarget.id, tx);
      if (deleted) {
        await this.auditLogService.record(
          {
            userId: lockedActor.id,
            action: 'USER_UNBLOCKED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              targetPublicId: lockedTarget.publicId,
            },
          },
          tx,
        );
      }

      return {
        blocked: false,
        message: SOCIAL_MESSAGES.userUnblocked,
      };
    });
  }

  async getOwnPrivacySettings(actor: AuthenticatedPrincipal): Promise<GetPrivacySettingsResult> {
    assertSocialAuthorized(actor, 'privacy:read', { targetUser: actor.user });

    const [freshUser, pendingFollowRequestsCount] = await Promise.all([
      this.repository.findUserById(actor.user.id),
      this.repository.countPendingFollowRequests(actor.user.id),
    ]);
    if (!isActiveSocialTarget(freshUser)) {
      throw new SocialDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SOCIAL_MESSAGES.notFound,
      });
    }

    return {
      privacy: {
        isPrivate: freshUser.isPrivate,
        showActiveStatus: freshUser.showActiveStatus,
        showReadReceipts: freshUser.showReadReceipts,
        pendingFollowRequestsCount,
      },
    };
  }

  /**
   * Cập nhật cài đặt Quyền riêng tư (`isPrivate`, `showActiveStatus`, `showReadReceipts`):
   * - Khi chuyển từ Riêng tư -> Công khai:
   *   1. Giao dịch đầu tiên khóa chính `actor` và đặt `is_private = false` ngay để chấm dứt phát sinh yêu cầu `'requested'` mới.
   *   2. Sau đó xử lý toàn bộ yêu cầu đang chờ theo từng lô nhỏ (`privacyBatchSize`, mặc định 100 dòng/transaction),
   *      mỗi lô khóa theo đúng thứ tự `id ASC FOR UPDATE` để tránh lock contention / deadlock.
   * - Khi tắt `showActiveStatus`: xóa ngay key Redis `presence:{userId}` để ẩn trạng thái tức thì.
   */
  async updateOwnPrivacySettings(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<UpdatePrivacySettingsResult> {
    assertSocialAuthorized(actor, 'privacy:update', { targetUser: actor.user });
    await this.consumeRateLimitOrThrow(
      `social:privacy:user:${actor.user.id}`,
      SOCIAL_RATE_LIMITS.updatePrivacyByUser,
    );

    const parsed = updatePrivacyInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new SocialDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SOCIAL_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const requestedIsPrivate = parsed.data.isPrivate;
    const requestedShowActiveStatus = parsed.data.showActiveStatus;
    const requestedShowReadReceipts = parsed.data.showReadReceipts;
    const acceptPendingRequests = parsed.data.acceptPendingRequests ?? true;
    const currentTime = this.now();

    // Bước 1: Cập nhật các cờ riêng tư nguyên tử trong 1 transaction.
    const step1 = await this.repository.getDb().transaction(async (tx) => {
      const lockedUsers = await this.repository.lockUsersInCanonicalOrder([actor.user.id], tx);
      const lockedActor = lockedUsers.get(actor.user.id);
      if (!isActiveSocialTarget(lockedActor)) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      const nextIsPrivate = requestedIsPrivate ?? lockedActor.isPrivate;
      const nextShowActiveStatus = requestedShowActiveStatus ?? lockedActor.showActiveStatus;
      const nextShowReadReceipts = requestedShowReadReceipts ?? lockedActor.showReadReceipts;

      const changed =
        lockedActor.isPrivate !== nextIsPrivate ||
        lockedActor.showActiveStatus !== nextShowActiveStatus ||
        lockedActor.showReadReceipts !== nextShowReadReceipts;

      const updatedUser = changed
        ? await this.repository.updateUserPrivacyFlags(
            lockedActor.id,
            {
              ...(requestedIsPrivate !== undefined ? { isPrivate: nextIsPrivate } : {}),
              ...(requestedShowActiveStatus !== undefined
                ? { showActiveStatus: nextShowActiveStatus }
                : {}),
              ...(requestedShowReadReceipts !== undefined
                ? { showReadReceipts: nextShowReadReceipts }
                : {}),
            },
            currentTime,
            tx,
          )
        : lockedActor;

      if (!updatedUser) {
        throw new SocialDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: SOCIAL_MESSAGES.notFound,
        });
      }

      if (changed) {
        await this.auditLogService.record(
          {
            userId: lockedActor.id,
            action: 'PRIVACY_UPDATED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              ...(requestedIsPrivate !== undefined
                ? {
                    isPrivate: nextIsPrivate,
                    acceptPendingRequests: !nextIsPrivate ? acceptPendingRequests : undefined,
                  }
                : {}),
              ...(requestedShowActiveStatus !== undefined
                ? { showActiveStatus: nextShowActiveStatus }
                : {}),
              ...(requestedShowReadReceipts !== undefined
                ? { showReadReceipts: nextShowReadReceipts }
                : {}),
            },
          },
          tx,
        );
      }

      return {
        isPrivate: updatedUser.isPrivate,
        showActiveStatus: updatedUser.showActiveStatus,
        showReadReceipts: updatedUser.showReadReceipts,
        followersCount: updatedUser.followersCount,
      };
    });

    // Nếu người dùng vừa tắt Trạng thái hoạt động -> xóa ngay key Redis `presence:{userId}`.
    if (requestedShowActiveStatus === false && this.presenceService) {
      await this.presenceService.clearUserPresence(actor.user.id);
    }

    // Bước 2: Khi chuyển sang chế độ Công khai, xử lý các yêu cầu `'requested'` còn tồn theo từng lô nhỏ.
    let acceptedRequestsCount = 0;
    let latestFollowersCount = step1.followersCount;

    if (requestedIsPrivate === false) {
      while (true) {
        const batchFollowerIds = await this.repository.fetchPendingRequesterBatch(
          actor.user.id,
          this.privacyBatchSize,
        );
        if (batchFollowerIds.length === 0) {
          break;
        }

        const batchDispatches: (PendingRealtimeDispatch | null)[] = [];

        const batchOutcome = await this.repository.getDb().transaction(async (tx) => {
          if (!acceptPendingRequests) {
            const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
              [actor.user.id],
              tx,
            );
            const lockedActor = lockedUsers.get(actor.user.id);
            if (!isActiveSocialTarget(lockedActor) || lockedActor.isPrivate) {
              return { stop: true, accepted: 0, followersCount: latestFollowersCount };
            }
            await this.repository.deletePendingRequestsForFollowers(
              lockedActor.id,
              batchFollowerIds,
              tx,
            );
            if (this.notificationService) {
              batchDispatches.push(
                await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
                  recipientId: lockedActor.id,
                  recipientPublicId: lockedActor.publicId,
                  actorIds: batchFollowerIds,
                }),
              );
            }
            return { stop: false, accepted: 0, followersCount: lockedActor.followersCount };
          }

          // Khóa lô `[actor.id, ...batchFollowerIds]` theo đúng thứ tự `id ASC FOR UPDATE`.
          const lockedUsers = await this.repository.lockUsersInCanonicalOrder(
            [actor.user.id, ...batchFollowerIds],
            tx,
          );
          const lockedActor = lockedUsers.get(actor.user.id);
          if (!isActiveSocialTarget(lockedActor) || lockedActor.isPrivate) {
            return { stop: true, accepted: 0, followersCount: latestFollowersCount };
          }

          const blockedIds = await this.repository.findBlockedUserIdsAmong(
            lockedActor.id,
            batchFollowerIds,
            tx,
          );

          const validActiveIds: string[] = [];
          const staleIds: string[] = [];
          for (const followerId of batchFollowerIds) {
            const candidate = lockedUsers.get(followerId);
            if (isActiveSocialTarget(candidate) && !blockedIds.has(followerId)) {
              validActiveIds.push(followerId);
            } else {
              staleIds.push(followerId);
            }
          }

          if (staleIds.length > 0) {
            await this.repository.deletePendingRequestsForFollowers(lockedActor.id, staleIds, tx);
            if (this.notificationService) {
              batchDispatches.push(
                await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
                  recipientId: lockedActor.id,
                  recipientPublicId: lockedActor.publicId,
                  actorIds: staleIds,
                }),
              );
            }
          }

          if (validActiveIds.length === 0) {
            return { stop: false, accepted: 0, followersCount: lockedActor.followersCount };
          }

          const acceptedIds = await this.repository.acceptPendingRequestsForFollowers(
            lockedActor.id,
            validActiveIds,
            currentTime,
            tx,
          );

          if (acceptedIds.length === 0) {
            return { stop: false, accepted: 0, followersCount: lockedActor.followersCount };
          }

          await this.repository.incrementFollowingCountForUsers(acceptedIds, currentTime, tx);
          const updatedActorCounters = await this.repository.adjustUserFollowCounters(
            lockedActor.id,
            { followersDelta: acceptedIds.length },
            currentTime,
            tx,
          );

          if (this.notificationService) {
            batchDispatches.push(
              await this.notificationService.removeFollowRequestNotificationsInTx(tx, {
                recipientId: lockedActor.id,
                recipientPublicId: lockedActor.publicId,
                actorIds: acceptedIds,
              }),
            );
            for (const acceptedId of acceptedIds) {
              const acceptedUser = lockedUsers.get(acceptedId);
              if (acceptedUser) {
                batchDispatches.push(
                  await this.notificationService.recordNotificationInTx(tx, {
                    recipient: acceptedUser,
                    actor: lockedActor,
                    type: 'follow_accepted',
                    entityPublicId: lockedActor.publicId,
                    now: currentTime,
                  }),
                );
              }
            }
          }

          return {
            stop: false,
            accepted: acceptedIds.length,
            followersCount:
              updatedActorCounters?.followersCount ??
              lockedActor.followersCount + acceptedIds.length,
          };
        });

        if (this.notificationService && batchDispatches.length > 0) {
          await this.notificationService.dispatchRealtimeEvents(batchDispatches);
        }

        acceptedRequestsCount += batchOutcome.accepted;
        latestFollowersCount = batchOutcome.followersCount;

        if (batchOutcome.stop) {
          break;
        }
      }
    }

    const [freshUser, pendingFollowRequestsCount] = await Promise.all([
      this.repository.findUserById(actor.user.id),
      this.repository.countPendingFollowRequests(actor.user.id),
    ]);

    const finalIsPrivate = freshUser?.isPrivate ?? step1.isPrivate;
    const onlyPrivateChanged =
      requestedIsPrivate !== undefined &&
      requestedShowActiveStatus === undefined &&
      requestedShowReadReceipts === undefined;

    return {
      privacy: {
        isPrivate: finalIsPrivate,
        showActiveStatus: freshUser?.showActiveStatus ?? step1.showActiveStatus,
        showReadReceipts: freshUser?.showReadReceipts ?? step1.showReadReceipts,
        pendingFollowRequestsCount,
      },
      acceptedRequestsCount,
      followersCount: freshUser?.followersCount ?? latestFollowersCount,
      message: onlyPrivateChanged
        ? finalIsPrivate
          ? SOCIAL_MESSAGES.privacyEnabled
          : SOCIAL_MESSAGES.privacyDisabled
        : SOCIAL_MESSAGES.privacyUpdated,
    };
  }
}

export function createSocialService(deps: SocialServiceDependencies = {}): SocialService {
  return new SocialService(deps);
}

const globalForSocial = globalThis as typeof globalThis & {
  __tomatoSocialService?: SocialService;
};

export function getSocialService(): SocialService {
  if (!globalForSocial.__tomatoSocialService) {
    globalForSocial.__tomatoSocialService = createSocialService();
  }
  return globalForSocial.__tomatoSocialService;
}

export function setSocialServiceForTesting(service: SocialService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setSocialServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSocial.__tomatoSocialService = service;
}

export function resetSocialServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetSocialServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForSocial.__tomatoSocialService = undefined;
}
