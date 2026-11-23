import 'server-only';

import {
  PRESENCE_RATE_LIMITS,
  getRateLimiter,
  getRedisClient,
  type RateLimiter,
  type RedisClient,
} from '@/core/redis';
import { formatZodErrorDetails } from '@/core/security/http-response';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { PresenceDomainError } from '@/modules/presence/presence.errors';
import { PRESENCE_MESSAGES } from '@/modules/presence/presence.messages';
import {
  assertPresenceAuthorized,
  canViewTargetPresence,
} from '@/modules/presence/presence.policy';
import { PresenceRepository } from '@/modules/presence/presence.repository';
import {
  presenceHeartbeatInputSchema,
  presenceQueryInputSchema,
} from '@/modules/presence/presence.schemas';

/**
 * Thiết kế tối ưu 1 key Redis duy nhất cho mỗi người dùng (`presence:{userId}`):
 * - Lưu Unix timestamp (ms) của heartbeat gần nhất với TTL 7 ngày (`EX 604800`).
 * - Chu kỳ heartbeat từ Client: 60 giây.
 * - Ngưỡng coi là đang trực tuyến: `now - lastSeen <= 105_000 ms` (trừ hao jitter mạng).
 */
export const PRESENCE_REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PRESENCE_ONLINE_THRESHOLD_MS = 105_000;
export const PRESENCE_MAX_VISIBLE_AGE_MS = PRESENCE_REDIS_TTL_SECONDS * 1000;

export type PresenceCoarseBucket = 'active_now' | 'few_minutes' | 'minutes' | 'hours' | 'days';

/**
 * DTO allowlist cho trạng thái hoạt động:
 * chỉ trả mốc thời gian làm tròn thô, TUYỆT ĐỐI KHÔNG trả timestamp chính xác từng giây.
 */
export interface PresenceStatusDto {
  readonly isOnline: boolean;
  readonly bucket: PresenceCoarseBucket;
  readonly label: string;
}

export interface PresenceHeartbeatResult {
  readonly active: boolean;
  readonly recorded: boolean;
  readonly onlineWindowSeconds: number;
}

export interface PresenceQueryResult {
  readonly viewerActiveStatusEnabled: boolean;
  readonly presences: Readonly<Record<string, PresenceStatusDto | null>>;
}

export interface PresenceServiceDependencies {
  readonly repository?: PresenceRepository;
  readonly redis?: Pick<RedisClient, 'get' | 'mget' | 'set' | 'del'>;
  readonly rateLimiter?: Pick<RateLimiter, 'consume'>;
  readonly now?: () => number;
}

export function buildPresenceRedisKey(userId: string): string {
  return `presence:${userId}`;
}

/**
 * Làm tròn thô khoảng thời gian từ lần hoạt động gần nhất (không lộ giây chính xác):
 * - <= 105 giây        -> Đang hoạt động (`isOnline: true`)
 * - 105 giây .. < 5p   -> Hoạt động vài phút trước
 * - 5p .. < 60p        -> Làm tròn xuống bội số 5 phút (5, 10, 15, ..., 55 phút trước)
 * - 1h .. < 24h        -> Làm tròn xuống giờ nguyên (1..23 giờ trước)
 * - 1d .. 7d           -> Làm tròn xuống ngày nguyên (1..7 ngày trước)
 * - > 7 ngày           -> `null`
 */
export function formatCoarsePresenceStatus(
  lastSeenMs: number,
  nowMs: number,
): PresenceStatusDto | null {
  if (!Number.isFinite(lastSeenMs) || lastSeenMs <= 0 || !Number.isFinite(nowMs)) {
    return null;
  }

  const elapsedMs = Math.max(0, nowMs - lastSeenMs);
  if (elapsedMs > PRESENCE_MAX_VISIBLE_AGE_MS) {
    return null;
  }

  if (elapsedMs <= PRESENCE_ONLINE_THRESHOLD_MS) {
    return {
      isOnline: true,
      bucket: 'active_now',
      label: PRESENCE_MESSAGES.activeNow,
    };
  }

  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  if (elapsedMs < FIVE_MINUTES_MS) {
    return {
      isOnline: false,
      bucket: 'few_minutes',
      label: PRESENCE_MESSAGES.fewMinutesAgo,
    };
  }

  if (elapsedMs < ONE_HOUR_MS) {
    const roundedMinutes = Math.floor(elapsedMs / FIVE_MINUTES_MS) * 5;
    return {
      isOnline: false,
      bucket: 'minutes',
      label: PRESENCE_MESSAGES.minutesAgo(roundedMinutes),
    };
  }

  if (elapsedMs < ONE_DAY_MS) {
    const hours = Math.floor(elapsedMs / ONE_HOUR_MS);
    return {
      isOnline: false,
      bucket: 'hours',
      label: PRESENCE_MESSAGES.hoursAgo(hours),
    };
  }

  const days = Math.floor(elapsedMs / ONE_DAY_MS);
  return {
    isOnline: false,
    bucket: 'days',
    label: PRESENCE_MESSAGES.daysAgo(days),
  };
}

export class PresenceService {
  private readonly repository: PresenceRepository;
  private readonly redis: Pick<RedisClient, 'get' | 'mget' | 'set' | 'del'>;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly now: () => number;

  constructor(deps: PresenceServiceDependencies = {}) {
    this.repository = deps.repository ?? new PresenceRepository();
    this.redis = deps.redis ?? getRedisClient();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.now = deps.now ?? (() => Date.now());
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof PRESENCE_RATE_LIMITS)[keyof typeof PRESENCE_RATE_LIMITS],
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new PresenceDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: PRESENCE_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  async clearUserPresence(userId: string): Promise<void> {
    await this.redis.del(buildPresenceRedisKey(userId));
  }

  async recordHeartbeat(
    actor: AuthenticatedPrincipal,
    rawInput: unknown = {},
  ): Promise<PresenceHeartbeatResult> {
    assertPresenceAuthorized(actor, 'presence:heartbeat');
    await this.consumeRateLimitOrThrow(
      `presence:heartbeat:user:${actor.user.id}`,
      PRESENCE_RATE_LIMITS.heartbeatByUser,
    );

    const parsed = presenceHeartbeatInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PresenceDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: PRESENCE_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const freshViewer = await this.repository.findUserPresenceRecordById(actor.user.id);
    if (!freshViewer || freshViewer.status !== 'active' || freshViewer.deletedAt !== null) {
      throw new PresenceDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PRESENCE_MESSAGES.notFound,
      });
    }

    if (!freshViewer.showActiveStatus) {
      await this.clearUserPresence(freshViewer.id);
      return {
        active: false,
        recorded: false,
        onlineWindowSeconds: 0,
      };
    }

    const nowMs = this.now();
    await this.redis.set(buildPresenceRedisKey(freshViewer.id), String(nowMs), {
      ex: PRESENCE_REDIS_TTL_SECONDS,
    });

    return {
      active: true,
      recorded: true,
      onlineWindowSeconds: Math.floor(PRESENCE_ONLINE_THRESHOLD_MS / 1000),
    };
  }

  async queryPresences(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<PresenceQueryResult> {
    assertPresenceAuthorized(actor, 'presence:query');
    await this.consumeRateLimitOrThrow(
      `presence:query:user:${actor.user.id}`,
      PRESENCE_RATE_LIMITS.queryByUser,
    );

    const parsed = presenceQueryInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PresenceDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: PRESENCE_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const uniqueRequestedPublicIds = Array.from(new Set(parsed.data.userPublicIds));
    const presences: Record<string, PresenceStatusDto | null> = {};
    for (const publicId of uniqueRequestedPublicIds) {
      presences[publicId] = null;
    }

    const freshViewer = await this.repository.findUserPresenceRecordById(actor.user.id);
    if (!freshViewer || freshViewer.status !== 'active' || freshViewer.deletedAt !== null) {
      throw new PresenceDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: PRESENCE_MESSAGES.notFound,
      });
    }

    // Cưỡng chế đối xứng: nếu chính người xem tắt `showActiveStatus`, trả `null` đồng loạt ngay lập tức.
    if (!freshViewer.showActiveStatus) {
      return {
        viewerActiveStatusEnabled: false,
        presences,
      };
    }

    const targetRecords =
      await this.repository.findUsersPresenceRecordsByPublicIds(uniqueRequestedPublicIds);
    const candidateTargetRecords = targetRecords.filter(
      (target) =>
        target.id !== freshViewer.id &&
        target.status === 'active' &&
        target.deletedAt === null &&
        target.showActiveStatus,
    );

    if (candidateTargetRecords.length === 0) {
      return {
        viewerActiveStatusEnabled: true,
        presences,
      };
    }

    const candidateIds = candidateTargetRecords.map((target) => target.id);
    const [blockedPeerIds, mutualFollowPeerIds, primaryConversationPeerIds] = await Promise.all([
      this.repository.findBlockedPeerIds(freshViewer.id, candidateIds),
      this.repository.findMutualFollowPeerIds(freshViewer.id, candidateIds),
      this.repository.findPrimaryConversationPeerIds(freshViewer.id, candidateIds),
    ]);

    const eligibleTargets = candidateTargetRecords.filter((target) =>
      canViewTargetPresence({
        viewer: freshViewer,
        target,
        isBidirectionallyBlocked: blockedPeerIds.has(target.id),
        isMutualFollow: mutualFollowPeerIds.has(target.id),
        hasPrimaryConversation: primaryConversationPeerIds.has(target.id),
      }),
    );

    if (eligibleTargets.length === 0) {
      return {
        viewerActiveStatusEnabled: true,
        presences,
      };
    }

    const redisKeys = eligibleTargets.map((target) => buildPresenceRedisKey(target.id));
    const rawTimestamps = await this.redis.mget(...redisKeys);
    const nowMs = this.now();

    for (let i = 0; i < eligibleTargets.length; i += 1) {
      const target = eligibleTargets[i];
      const rawValue = rawTimestamps[i];
      if (!target || rawValue === null || rawValue === undefined) {
        continue;
      }
      const parsedTimestamp = Number(rawValue);
      presences[target.publicId.toLowerCase()] = formatCoarsePresenceStatus(parsedTimestamp, nowMs);
    }

    return {
      viewerActiveStatusEnabled: true,
      presences,
    };
  }
}

export function createPresenceService(deps: PresenceServiceDependencies = {}): PresenceService {
  return new PresenceService(deps);
}

const globalForPresence = globalThis as typeof globalThis & {
  __tomatoPresenceService?: PresenceService;
};

export function getPresenceService(): PresenceService {
  if (!globalForPresence.__tomatoPresenceService) {
    globalForPresence.__tomatoPresenceService = createPresenceService();
  }
  return globalForPresence.__tomatoPresenceService;
}

export function setPresenceServiceForTesting(service: PresenceService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setPresenceServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForPresence.__tomatoPresenceService = service;
}

export function resetPresenceServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetPresenceServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForPresence.__tomatoPresenceService = undefined;
}
