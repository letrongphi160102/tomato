import 'server-only';

import { isPostgresUniqueViolation } from '@/core/db';
import type { UserRow } from '@/core/db/schema';
import { logger } from '@/core/logger';
import { AvatarValidationError, processAvatarImage } from '@/core/media';
import { PROFILE_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { getAuditLogService, type AuditLogService } from '@/core/security/audit-log.service';
import type { RequestClientContext } from '@/core/security/client-context';
import { formatZodErrorDetails } from '@/core/security/http-response';
import { getMediaStorageProvider, type MediaStorageProvider } from '@/core/storage';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { ProfileDomainError } from '@/modules/profile/profile.errors';
import { PROFILE_MESSAGES } from '@/modules/profile/profile.messages';
import {
  assertCanModifyOwnProfile,
  assertCanReadProfile,
  assertCanSearchProfiles,
} from '@/modules/profile/profile.policy';
import { ProfileRepository } from '@/modules/profile/profile.repository';
import {
  handleRouteParamSchema,
  searchUsersQuerySchema,
  updateOwnProfileInputSchema,
} from '@/modules/profile/profile.schemas';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  canViewTargetConnections,
  type SocialFollowStatus,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';
import { SocialRepository } from '@/modules/social/social.repository';

export const HANDLE_CHANGE_MAX_PER_WINDOW = 2;
export const HANDLE_CHANGE_WINDOW_DAYS = 14;
export const HANDLE_CHANGE_WINDOW_MS = HANDLE_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const HANDLE_RESERVATION_DAYS = 14;
export const HANDLE_RESERVATION_MS = HANDLE_RESERVATION_DAYS * 24 * 60 * 60 * 1000;

/**
 * DTO allowlist cho hồ sơ người dùng hiển thị công khai (tuyệt đối không chứa `id` UUIDv7,
 * `avatarStorageKey`, email hay trường nội bộ).
 * Đối với tài khoản Riêng tư khi người lạ chưa được duyệt xem: chỉ trả khung tối thiểu (`canViewConnections: false`).
 */
export interface UserProfileDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly followersCount: number;
  readonly followingCount: number;
  readonly isOwnProfile: boolean;
  readonly followStatus: SocialFollowStatus;
  /** Chỉ `true` khi đối phương đang có `status = 'following'` với người xem. */
  readonly followedBy: boolean;
  readonly canViewConnections: boolean;
}

export interface OwnProfileDto extends UserProfileDto {
  readonly handleChangedAt: string | null;
  readonly handleChangesRemaining: number;
  readonly nextHandleChangeAvailableAt: string | null;
}

export interface UserSearchItemDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly followStatus: SocialFollowStatus;
  readonly isOwnProfile: boolean;
}

export interface SearchUsersResult {
  readonly items: readonly UserSearchItemDto[];
}

export interface GetProfileResult {
  readonly profile: UserProfileDto;
}

export interface GetOwnProfileResult {
  readonly profile: OwnProfileDto;
}

export interface UpdateOwnProfileResult {
  readonly profile: OwnProfileDto;
  readonly message: string;
}

export interface AvatarMutationResult {
  readonly avatarUrl: string | null;
  readonly message: string;
}

export interface ProfileServiceDependencies {
  readonly repository?: ProfileRepository;
  readonly socialRepository?: SocialRepository;
  readonly rateLimiter?: RateLimiter;
  readonly storageProvider?: MediaStorageProvider;
  readonly auditLogService?: AuditLogService;
  readonly now?: () => Date;
}

type UpdateProfileTxOutcome =
  | { readonly kind: 'updated'; readonly user: UserRow; readonly recentChangeTimestamps: Date[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'handle_unavailable' }
  | { readonly kind: 'handle_limit_reached'; readonly retryAfterSeconds: number };

export function toUserProfileDto(
  user: UserRow,
  viewerUserId?: string,
  relationship: SocialRelationshipSnapshot = EMPTY_SOCIAL_RELATIONSHIP,
): UserProfileDto {
  const isOwnProfile = viewerUserId !== undefined && viewerUserId === user.id;
  const canViewConnections =
    viewerUserId !== undefined
      ? canViewTargetConnections(viewerUserId, user, relationship)
      : !user.isPrivate;

  return {
    public_id: user.publicId,
    handle: user.handle,
    fullName: user.fullName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    isPrivate: user.isPrivate,
    followersCount: user.followersCount,
    followingCount: user.followingCount,
    isOwnProfile,
    followStatus: isOwnProfile ? 'none' : relationship.actorFollowStatus,
    followedBy: isOwnProfile ? false : relationship.targetFollowStatus === 'following',
    canViewConnections,
  };
}

function computeHandleChangeQuota(
  recentChangeTimestamps: readonly Date[],
  now: Date,
): {
  readonly handleChangesRemaining: number;
  readonly nextHandleChangeAvailableAt: string | null;
} {
  const count = recentChangeTimestamps.length;
  const remaining = Math.max(0, HANDLE_CHANGE_MAX_PER_WINDOW - count);
  if (remaining > 0) {
    return {
      handleChangesRemaining: remaining,
      nextHandleChangeAvailableAt: null,
    };
  }

  // Lấy mốc cũ nhất trong nhóm `HANDLE_CHANGE_MAX_PER_WINDOW` lần đổi gần nhất + 14 ngày.
  const sortedDesc = [...recentChangeTimestamps].sort((a, b) => b.getTime() - a.getTime());
  const limitingChange =
    sortedDesc[HANDLE_CHANGE_MAX_PER_WINDOW - 1] ?? sortedDesc[sortedDesc.length - 1];
  const nextAvailableMs = limitingChange
    ? limitingChange.getTime() + HANDLE_CHANGE_WINDOW_MS
    : now.getTime() + HANDLE_CHANGE_WINDOW_MS;

  return {
    handleChangesRemaining: 0,
    nextHandleChangeAvailableAt: new Date(nextAvailableMs).toISOString(),
  };
}

export function toOwnProfileDto(
  user: UserRow,
  recentChangeTimestamps: readonly Date[],
  now: Date,
): OwnProfileDto {
  const quota = computeHandleChangeQuota(recentChangeTimestamps, now);
  return {
    ...toUserProfileDto(user, user.id),
    handleChangedAt: user.handleChangedAt ? user.handleChangedAt.toISOString() : null,
    handleChangesRemaining: quota.handleChangesRemaining,
    nextHandleChangeAvailableAt: quota.nextHandleChangeAvailableAt,
  };
}

export class ProfileService {
  private readonly repository: ProfileRepository;
  private readonly socialRepository: SocialRepository;
  private readonly rateLimiter: RateLimiter;
  private readonly storageProvider: MediaStorageProvider;
  private readonly auditLogService: AuditLogService;
  private readonly now: () => Date;

  constructor(deps: ProfileServiceDependencies = {}) {
    this.repository = deps.repository ?? new ProfileRepository();
    this.socialRepository = deps.socialRepository ?? new SocialRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.storageProvider = deps.storageProvider ?? getMediaStorageProvider();
    this.auditLogService = deps.auditLogService ?? getAuditLogService();
    this.now = deps.now ?? (() => new Date());
  }

  async searchUsers(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<SearchUsersResult> {
    assertCanSearchProfiles(actor);

    const limitResult = await this.rateLimiter.consume(
      `profile:search:user:${actor.user.id}`,
      PROFILE_RATE_LIMITS.searchByUser,
    );
    if (!limitResult.allowed) {
      throw new ProfileDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: PROFILE_MESSAGES.rateLimited(limitResult.retryAfterSeconds),
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
    }

    const parsed = searchUsersQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ProfileDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: PROFILE_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const rows = await this.repository.searchActiveUsers({
      query: parsed.data.q,
      limit: parsed.data.limit,
      viewerUserId: actor.user.id,
    });

    return {
      items: rows.map((row) => ({
        public_id: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        isPrivate: row.isPrivate,
        followStatus: row.followStatus ?? 'none',
        isOwnProfile: row.isOwnProfile ?? row.publicId === actor.user.publicId,
      })),
    };
  }

  async getProfileByHandle(
    actor: AuthenticatedPrincipal,
    rawHandle: string,
    options: { readonly skipRateLimit?: boolean } = {},
  ): Promise<GetProfileResult> {
    assertCanSearchProfiles(actor);

    if (!options.skipRateLimit) {
      const limitResult = await this.rateLimiter.consume(
        `profile:read:user:${actor.user.id}`,
        PROFILE_RATE_LIMITS.getProfileByUser,
      );
      if (!limitResult.allowed) {
        throw new ProfileDomainError({
          status: 429,
          code: 'RATE_LIMITED',
          message: PROFILE_MESSAGES.rateLimited(limitResult.retryAfterSeconds),
          retryAfterSeconds: limitResult.retryAfterSeconds,
        });
      }
    }

    const parsed = handleRouteParamSchema.safeParse(rawHandle);
    if (!parsed.success) {
      throw new ProfileDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PROFILE_MESSAGES.profileNotFound,
      });
    }

    const targetUser = await this.repository.findUserByHandleNormalized(parsed.data);
    if (!targetUser) {
      throw new ProfileDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PROFILE_MESSAGES.profileNotFound,
      });
    }

    const relationship: SocialRelationshipSnapshot =
      targetUser.id === actor.user.id
        ? EMPTY_SOCIAL_RELATIONSHIP
        : await this.socialRepository.getRelationshipSnapshot(actor.user.id, targetUser.id);

    assertCanReadProfile(actor, targetUser, relationship);

    return {
      profile: toUserProfileDto(targetUser, actor.user.id, relationship),
    };
  }

  async getOwnProfile(actor: AuthenticatedPrincipal): Promise<GetOwnProfileResult> {
    assertCanModifyOwnProfile(actor, 'profile:update', actor.user);

    const currentTime = this.now();
    const freshUser = await this.repository.findUserById(actor.user.id);
    assertCanReadProfile(actor, freshUser);

    const windowStart = new Date(currentTime.getTime() - HANDLE_CHANGE_WINDOW_MS);
    const recentChanges = await this.repository.listRecentHandleChanges(freshUser.id, windowStart);

    return {
      profile: toOwnProfileDto(
        freshUser,
        recentChanges.map((item) => item.createdAt),
        currentTime,
      ),
    };
  }

  async updateOwnProfile(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
    context: RequestClientContext,
  ): Promise<UpdateOwnProfileResult> {
    assertCanModifyOwnProfile(actor, 'profile:update', actor.user);

    const limitResult = await this.rateLimiter.consume(
      `profile:update:user:${actor.user.id}`,
      PROFILE_RATE_LIMITS.updateProfileByUser,
    );
    if (!limitResult.allowed) {
      throw new ProfileDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: PROFILE_MESSAGES.rateLimited(limitResult.retryAfterSeconds),
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
    }

    const parsed = updateOwnProfileInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ProfileDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: PROFILE_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const input = parsed.data;
    const currentTime = this.now();
    const windowStart = new Date(currentTime.getTime() - HANDLE_CHANGE_WINDOW_MS);

    let outcome: UpdateProfileTxOutcome;
    try {
      outcome = await this.repository.getDb().transaction<UpdateProfileTxOutcome>(async (tx) => {
        const lockedUser = await this.repository.lockUserById(actor.user.id, tx);
        if (!lockedUser || lockedUser.status !== 'active' || lockedUser.deletedAt !== null) {
          return { kind: 'not_found' };
        }

        const requestedHandle = input.handle;
        const isChangingHandle =
          requestedHandle !== undefined && requestedHandle !== lockedUser.handleNormalized;

        const recentChanges = await this.repository.listRecentHandleChanges(
          lockedUser.id,
          windowStart,
          tx,
        );
        const recentTimestamps = recentChanges.map((item) => item.createdAt);

        if (isChangingHandle) {
          // Bắt buộc dùng `pg_advisory_xact_lock` (transaction-scoped) tương thích Neon PgBouncer.
          await this.repository.acquireHandleLock(requestedHandle, tx);

          if (recentChanges.length >= HANDLE_CHANGE_MAX_PER_WINDOW) {
            const oldestInQuota = recentChanges[HANDLE_CHANGE_MAX_PER_WINDOW - 1];
            const unlockAtMs = oldestInQuota
              ? oldestInQuota.createdAt.getTime() + HANDLE_CHANGE_WINDOW_MS
              : currentTime.getTime() + HANDLE_CHANGE_WINDOW_MS;
            const retryAfterSeconds = Math.max(
              1,
              Math.ceil((unlockAtMs - currentTime.getTime()) / 1000),
            );
            return { kind: 'handle_limit_reached', retryAfterSeconds };
          }

          const existingOwner = await this.repository.findUserByHandleNormalized(
            requestedHandle,
            tx,
          );
          if (existingOwner && existingOwner.id !== lockedUser.id) {
            return { kind: 'handle_unavailable' };
          }

          const reservedByOther = await this.repository.isHandleReservedByOtherUser(
            requestedHandle,
            lockedUser.id,
            currentTime,
            tx,
          );
          if (reservedByOther) {
            return { kind: 'handle_unavailable' };
          }

          const reservedUntil = new Date(currentTime.getTime() + HANDLE_RESERVATION_MS);
          await this.repository.recordHandleHistory(
            {
              userId: lockedUser.id,
              oldHandleNormalized: lockedUser.handleNormalized,
              reservedUntil,
              createdAt: currentTime,
            },
            tx,
          );
          recentTimestamps.unshift(currentTime);
        }

        const updatedUser = await this.repository.updateUserProfile(
          {
            userId: lockedUser.id,
            fullName: input.fullName,
            handle: isChangingHandle ? requestedHandle : undefined,
            bio: input.bio,
            now: currentTime,
            handleChanged: isChangingHandle,
          },
          tx,
        );
        if (!updatedUser) {
          return { kind: 'not_found' };
        }

        await this.auditLogService.record(
          {
            userId: lockedUser.id,
            action: isChangingHandle ? 'PROFILE_HANDLE_CHANGED' : 'PROFILE_UPDATED',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              updatedFields: [
                ...(input.fullName !== undefined ? ['fullName'] : []),
                ...(isChangingHandle ? ['handle'] : []),
                ...(input.bio !== undefined ? ['bio'] : []),
              ],
            },
          },
          tx,
        );

        return {
          kind: 'updated',
          user: updatedUser,
          recentChangeTimestamps: recentTimestamps,
        };
      });
    } catch (error) {
      if (
        isPostgresUniqueViolation(error, 'idx_users_handle_norm') ||
        isPostgresUniqueViolation(error, 'users_username_unique')
      ) {
        throw new ProfileDomainError({
          status: 409,
          code: 'CONFLICT',
          message: PROFILE_MESSAGES.handleUnavailable,
          details: [{ field: 'handle', message: PROFILE_MESSAGES.handleUnavailable }],
        });
      }
      throw error;
    }

    switch (outcome.kind) {
      case 'not_found':
        throw new ProfileDomainError({
          status: 404,
          code: 'NOT_FOUND',
          message: PROFILE_MESSAGES.profileNotFound,
        });
      case 'handle_unavailable':
        throw new ProfileDomainError({
          status: 409,
          code: 'CONFLICT',
          message: PROFILE_MESSAGES.handleUnavailable,
          details: [{ field: 'handle', message: PROFILE_MESSAGES.handleUnavailable }],
        });
      case 'handle_limit_reached':
        throw new ProfileDomainError({
          status: 429,
          code: 'RATE_LIMITED',
          message: PROFILE_MESSAGES.handleChangeLimitReached,
          details: [{ field: 'handle', message: PROFILE_MESSAGES.handleChangeLimitReached }],
          retryAfterSeconds: outcome.retryAfterSeconds,
        });
      case 'updated':
        return {
          profile: toOwnProfileDto(outcome.user, outcome.recentChangeTimestamps, currentTime),
          message: PROFILE_MESSAGES.profileUpdated,
        };
    }
  }

  async uploadOwnAvatar(
    actor: AuthenticatedPrincipal,
    fileBuffer: Buffer,
    context: RequestClientContext,
  ): Promise<AvatarMutationResult> {
    assertCanModifyOwnProfile(actor, 'avatar:update', actor.user);

    // Rate limit 5 lần/giờ/user chạy TRƯỚC khi giải mã ảnh nặng bằng sharp.
    const limitResult = await this.rateLimiter.consume(
      `profile:avatar:upload:user:${actor.user.id}`,
      PROFILE_RATE_LIMITS.uploadAvatarByUser,
    );
    if (!limitResult.allowed) {
      throw new ProfileDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: PROFILE_MESSAGES.avatarRateLimited,
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
    }

    let processed;
    try {
      processed = await processAvatarImage(fileBuffer);
    } catch (error) {
      if (error instanceof AvatarValidationError) {
        throw new ProfileDomainError({
          status: error.reason === 'FILE_TOO_LARGE' ? 413 : 400,
          code: 'VALIDATION_ERROR',
          message: PROFILE_MESSAGES.invalidAvatar,
          details: [{ field: 'file', message: PROFILE_MESSAGES.invalidAvatar }],
        });
      }
      throw error;
    }

    const stored = await this.storageProvider.putObject({
      storageKey: processed.storageKey,
      body: processed.buffer,
      contentType: processed.contentType,
    });

    const currentTime = this.now();
    let dbResult;
    try {
      dbResult = await this.repository.updateUserAvatarAtomic({
        userId: actor.user.id,
        avatarUrl: stored.url,
        avatarStorageKey: stored.storageKey,
        now: currentTime,
      });
    } catch (error) {
      await this.safeDeleteStorageObject(stored.storageKey, 'rollback_new_avatar');
      throw error;
    }

    if (!dbResult) {
      await this.safeDeleteStorageObject(stored.storageKey, 'inactive_user_cleanup');
      throw new ProfileDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PROFILE_MESSAGES.profileNotFound,
      });
    }

    await this.auditLogService
      .record({
        userId: actor.user.id,
        action: 'AVATAR_UPDATED',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          byteLength: stored.byteLength,
          storageProvider: this.storageProvider.provider,
        },
      })
      .catch(() => undefined);

    if (dbResult.previousStorageKey && dbResult.previousStorageKey !== stored.storageKey) {
      await this.safeDeleteStorageObject(dbResult.previousStorageKey, 'delete_previous_avatar');
    }

    return {
      avatarUrl: stored.url,
      message: PROFILE_MESSAGES.avatarUpdated,
    };
  }

  async deleteOwnAvatar(
    actor: AuthenticatedPrincipal,
    context: RequestClientContext,
  ): Promise<AvatarMutationResult> {
    assertCanModifyOwnProfile(actor, 'avatar:delete', actor.user);

    const limitResult = await this.rateLimiter.consume(
      `profile:avatar:delete:user:${actor.user.id}`,
      PROFILE_RATE_LIMITS.deleteAvatarByUser,
    );
    if (!limitResult.allowed) {
      throw new ProfileDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: PROFILE_MESSAGES.rateLimited(limitResult.retryAfterSeconds),
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
    }

    const dbResult = await this.repository.updateUserAvatarAtomic({
      userId: actor.user.id,
      avatarUrl: null,
      avatarStorageKey: null,
      now: this.now(),
    });

    if (!dbResult) {
      throw new ProfileDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PROFILE_MESSAGES.profileNotFound,
      });
    }

    if (dbResult.previousStorageKey) {
      await this.safeDeleteStorageObject(dbResult.previousStorageKey, 'remove_avatar');
      await this.auditLogService
        .record({
          userId: actor.user.id,
          action: 'AVATAR_REMOVED',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            storageProvider: this.storageProvider.provider,
          },
        })
        .catch(() => undefined);
    }

    return {
      avatarUrl: null,
      message: PROFILE_MESSAGES.avatarRemoved,
    };
  }

  private async safeDeleteStorageObject(storageKey: string, stage: string): Promise<void> {
    try {
      await this.storageProvider.deleteObject(storageKey);
    } catch (error) {
      const errorName =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { readonly name?: unknown }).name)
          : 'Error';
      logger.warn(
        {
          component: 'profile-service',
          stage,
          storageProvider: this.storageProvider.provider,
          errorName,
        },
        'Không thể xóa tệp ảnh đại diện cũ trên bộ lưu trữ',
      );
    }
  }
}

export function createProfileService(deps: ProfileServiceDependencies = {}): ProfileService {
  return new ProfileService(deps);
}

const globalForProfile = globalThis as typeof globalThis & {
  __tomatoProfileService?: ProfileService;
};

export function getProfileService(): ProfileService {
  if (!globalForProfile.__tomatoProfileService) {
    globalForProfile.__tomatoProfileService = createProfileService();
  }
  return globalForProfile.__tomatoProfileService;
}

export function setProfileServiceForTesting(service: ProfileService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setProfileServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForProfile.__tomatoProfileService = service;
}

export function resetProfileServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetProfileServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForProfile.__tomatoProfileService = undefined;
}
