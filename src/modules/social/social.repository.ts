import 'server-only';

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DatabaseTransaction, type DbExecutor } from '@/core/db';
import {
  blocks,
  conversationParticipants,
  conversations,
  follows,
  users,
  type FollowRow,
  type FollowStatus,
  type UserRow,
} from '@/core/db/schema';
import { escapeSqlLikePattern } from '@/modules/profile/handle';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  type SocialFollowStatus,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';
import type { SocialKeysetCursor } from '@/modules/social/social.schemas';

export interface SocialConnectionListRecord {
  readonly publicId: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly viewerFollowStatus: SocialFollowStatus;
  readonly followedBy: boolean;
  readonly isSelf: boolean;
  readonly cursorCreatedAtIso: string;
}

export interface SocialFollowRequestRecord {
  readonly publicId: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly requestedAt: Date;
  readonly cursorCreatedAtIso: string;
}

export interface SocialBlockedUserRecord {
  readonly publicId: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly blockedAt: Date;
  readonly cursorCreatedAtIso: string;
}

export interface DeletedFollowRowSummary {
  readonly followerId: string;
  readonly followeeId: string;
  readonly status: FollowStatus;
}

export interface ListConnectionsParams {
  readonly targetUserId: string;
  readonly viewerUserId: string;
  readonly limit: number;
  readonly cursor?: SocialKeysetCursor;
  readonly query?: string;
}

export interface ListSimpleSocialParams {
  readonly actorUserId: string;
  readonly limit: number;
  readonly cursor?: SocialKeysetCursor;
}

function sortUniqueIdsAscending(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeNullableFollowStatus(raw: string | null | undefined): SocialFollowStatus {
  if (raw === 'following' || raw === 'requested') {
    return raw;
  }
  return 'none';
}

export class SocialRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  getDb(): Database {
    return this.getDefaultDb();
  }

  async findUserById(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ?? null;
  }

  async findUserByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.publicId, publicId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Khóa tập bản ghi `users` theo đúng thứ tự `id ASC FOR UPDATE` nhằm triệt tiêu deadlock
   * giữa các transaction đồng thời thao tác ngược chiều (ví dụ A follow B cùng lúc B block A).
   */
  async lockUsersInCanonicalOrder(
    userIds: readonly string[],
    tx: DatabaseTransaction,
  ): Promise<Map<string, UserRow>> {
    const sortedIds = sortUniqueIdsAscending(userIds);
    if (sortedIds.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select()
      .from(users)
      .where(inArray(users.id, sortedIds))
      .orderBy(asc(users.id))
      .for('update');

    const map = new Map<string, UserRow>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  /**
   * Truy vấn trạng thái chặn 2 chiều và trạng thái follow 2 chiều trực tiếp từ PostgreSQL
   * sử dụng index `uq_blocks_blocker_blocked`, `idx_blocks_blocked_blocker` và `uq_follows_follower_followee`.
   */
  async getRelationshipSnapshot(
    actorId: string,
    targetId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialRelationshipSnapshot> {
    if (actorId === targetId) {
      return EMPTY_SOCIAL_RELATIONSHIP;
    }

    const [blockRows, followRows] = await Promise.all([
      executor
        .select({
          blockerId: blocks.blockerId,
          blockedId: blocks.blockedId,
        })
        .from(blocks)
        .where(
          or(
            and(eq(blocks.blockerId, actorId), eq(blocks.blockedId, targetId)),
            and(eq(blocks.blockerId, targetId), eq(blocks.blockedId, actorId)),
          ),
        ),
      executor
        .select({
          followerId: follows.followerId,
          followeeId: follows.followeeId,
          status: follows.status,
        })
        .from(follows)
        .where(
          or(
            and(eq(follows.followerId, actorId), eq(follows.followeeId, targetId)),
            and(eq(follows.followerId, targetId), eq(follows.followeeId, actorId)),
          ),
        ),
    ]);

    let blockedByActor = false;
    let blockedByTarget = false;
    for (const row of blockRows) {
      if (row.blockerId === actorId && row.blockedId === targetId) {
        blockedByActor = true;
      } else if (row.blockerId === targetId && row.blockedId === actorId) {
        blockedByTarget = true;
      }
    }

    let actorFollowStatus: SocialFollowStatus = 'none';
    let targetFollowStatus: SocialFollowStatus = 'none';
    for (const row of followRows) {
      if (row.followerId === actorId && row.followeeId === targetId) {
        actorFollowStatus = row.status;
      } else if (row.followerId === targetId && row.followeeId === actorId) {
        targetFollowStatus = row.status;
      }
    }

    return {
      blockedByActor,
      blockedByTarget,
      actorFollowStatus,
      targetFollowStatus,
    };
  }

  async findBlockedUserIdsAmong(
    actorId: string,
    candidateUserIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Set<string>> {
    const uniqueCandidates = Array.from(new Set(candidateUserIds));
    if (uniqueCandidates.length === 0) {
      return new Set();
    }

    const rows = await executor
      .select({
        blockerId: blocks.blockerId,
        blockedId: blocks.blockedId,
      })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, actorId), inArray(blocks.blockedId, uniqueCandidates)),
          and(inArray(blocks.blockerId, uniqueCandidates), eq(blocks.blockedId, actorId)),
        ),
      );

    const blockedSet = new Set<string>();
    for (const row of rows) {
      blockedSet.add(row.blockerId === actorId ? row.blockedId : row.blockerId);
    }
    return blockedSet;
  }

  async findFollowRow(
    followerId: string,
    followeeId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<FollowRow | null> {
    const rows = await executor
      .select()
      .from(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertFollowRow(
    params: {
      readonly followerId: string;
      readonly followeeId: string;
      readonly status: FollowStatus;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<FollowRow> {
    const rows = await tx
      .insert(follows)
      .values({
        id: generateUuidV7(),
        followerId: params.followerId,
        followeeId: params.followeeId,
        status: params.status,
        createdAt: params.now,
        updatedAt: params.now,
      })
      .returning();
    const created = rows[0];
    if (!created) {
      throw new Error('Không thể tạo bản ghi theo dõi.');
    }
    return created;
  }

  async upgradePendingFollowToFollowing(
    followerId: string,
    followeeId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(follows)
      .set({
        status: 'following',
        updatedAt: now,
      })
      .where(
        and(
          eq(follows.followerId, followerId),
          eq(follows.followeeId, followeeId),
          eq(follows.status, 'requested'),
        ),
      )
      .returning({ id: follows.id });
    return rows.length > 0;
  }

  async deleteFollowRow(
    followerId: string,
    followeeId: string,
    tx: DatabaseTransaction,
    expectedStatus?: FollowStatus,
  ): Promise<FollowStatus | null> {
    const conditions = [eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)];
    if (expectedStatus) {
      conditions.push(eq(follows.status, expectedStatus));
    }

    const rows = await tx
      .delete(follows)
      .where(and(...conditions))
      .returning({ status: follows.status });
    return rows[0]?.status ?? null;
  }

  async deleteFollowsBothDirections(
    userAId: string,
    userBId: string,
    tx: DatabaseTransaction,
  ): Promise<DeletedFollowRowSummary[]> {
    return tx
      .delete(follows)
      .where(
        or(
          and(eq(follows.followerId, userAId), eq(follows.followeeId, userBId)),
          and(eq(follows.followerId, userBId), eq(follows.followeeId, userAId)),
        ),
      )
      .returning({
        followerId: follows.followerId,
        followeeId: follows.followeeId,
        status: follows.status,
      });
  }

  async insertBlockIfAbsent(
    blockerId: string,
    blockedId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .insert(blocks)
      .values({
        id: generateUuidV7(),
        blockerId,
        blockedId,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [blocks.blockerId, blocks.blockedId],
      })
      .returning({ id: blocks.id });
    return rows.length > 0;
  }

  async deleteBlockRow(
    blockerId: string,
    blockedId: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .delete(blocks)
      .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
      .returning({ id: blocks.id });
    return rows.length > 0;
  }

  async adjustUserFollowCounters(
    userId: string,
    deltas: { readonly followersDelta?: number; readonly followingDelta?: number },
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<{ readonly followersCount: number; readonly followingCount: number } | null> {
    const followersDelta = deltas.followersDelta ?? 0;
    const followingDelta = deltas.followingDelta ?? 0;

    const patch: Record<string, unknown> = {
      updatedAt: now,
    };

    if (followersDelta !== 0) {
      patch.followersCount = sql`GREATEST(0, ${users.followersCount} + ${followersDelta})`;
    }
    if (followingDelta !== 0) {
      patch.followingCount = sql`GREATEST(0, ${users.followingCount} + ${followingDelta})`;
    }

    const rows = await tx.update(users).set(patch).where(eq(users.id, userId)).returning({
      followersCount: users.followersCount,
      followingCount: users.followingCount,
    });

    return rows[0] ?? null;
  }

  async updateUserPrivacyFlags(
    userId: string,
    flags: {
      readonly isPrivate?: boolean;
      readonly showActiveStatus?: boolean;
      readonly showReadReceipts?: boolean;
    },
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<UserRow | null> {
    const patch: Partial<typeof users.$inferInsert> = {
      updatedAt: now,
    };
    if (flags.isPrivate !== undefined) {
      patch.isPrivate = flags.isPrivate;
    }
    if (flags.showActiveStatus !== undefined) {
      patch.showActiveStatus = flags.showActiveStatus;
    }
    if (flags.showReadReceipts !== undefined) {
      patch.showReadReceipts = flags.showReadReceipts;
    }

    const rows = await tx.update(users).set(patch).where(eq(users.id, userId)).returning();
    return rows[0] ?? null;
  }

  async setUserPrivacyFlag(
    userId: string,
    isPrivate: boolean,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<UserRow | null> {
    return this.updateUserPrivacyFlags(userId, { isPrivate }, now, tx);
  }

  async fetchPendingRequesterBatch(
    followeeId: string,
    batchSize: number,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<string[]> {
    const rows = await executor
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(and(eq(follows.followeeId, followeeId), eq(follows.status, 'requested')))
      .orderBy(asc(follows.createdAt), asc(follows.id))
      .limit(batchSize);

    return rows.map((row) => row.followerId);
  }

  async deletePendingRequestsForFollowers(
    followeeId: string,
    followerIds: readonly string[],
    tx: DatabaseTransaction,
  ): Promise<number> {
    if (followerIds.length === 0) {
      return 0;
    }
    const rows = await tx
      .delete(follows)
      .where(
        and(
          eq(follows.followeeId, followeeId),
          eq(follows.status, 'requested'),
          inArray(follows.followerId, [...followerIds]),
        ),
      )
      .returning({ id: follows.id });
    return rows.length;
  }

  async acceptPendingRequestsForFollowers(
    followeeId: string,
    followerIds: readonly string[],
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<string[]> {
    if (followerIds.length === 0) {
      return [];
    }
    const rows = await tx
      .update(follows)
      .set({
        status: 'following',
        updatedAt: now,
      })
      .where(
        and(
          eq(follows.followeeId, followeeId),
          eq(follows.status, 'requested'),
          inArray(follows.followerId, [...followerIds]),
        ),
      )
      .returning({ followerId: follows.followerId });

    return rows.map((row) => row.followerId);
  }

  async incrementFollowingCountForUsers(
    userIds: readonly string[],
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await tx
      .update(users)
      .set({
        followingCount: sql`${users.followingCount} + 1`,
        updatedAt: now,
      })
      .where(inArray(users.id, [...userIds]));
  }

  async countPendingFollowRequests(
    followeeId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<number> {
    const rows = await executor
      .select({
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .where(
        and(
          eq(follows.followeeId, followeeId),
          eq(follows.status, 'requested'),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${blocks} b
            WHERE (b.blocker_id = ${followeeId} AND b.blocked_id = ${users.id})
               OR (b.blocker_id = ${users.id} AND b.blocked_id = ${followeeId})
          )`,
        ),
      );

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Danh sách Người theo dõi của `targetUserId`:
   * - Sắp xếp chuẩn `ORDER BY follows.created_at DESC, users.public_id DESC`.
   * - Lọc keyset chính xác theo cặp `(created_at, public_id)` ở độ chính xác microsecond.
   * - Lọc chặn hai chiều với `viewerUserId` ngay trong SQL.
   * - Tham số tìm nhanh `q` chỉ tìm trên `handle_normalized` và `full_name` (tuyệt đối không tìm email).
   */
  async listFollowers(
    params: ListConnectionsParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialConnectionListRecord[]> {
    return this.listConnectionsInternal('followers', params, executor);
  }

  /**
   * Danh sách Đang theo dõi của `targetUserId` (cùng quy tắc keyset, lọc chặn 2 chiều & tìm nhanh không dùng email).
   */
  async listFollowing(
    params: ListConnectionsParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialConnectionListRecord[]> {
    return this.listConnectionsInternal('following', params, executor);
  }

  private async listConnectionsInternal(
    direction: 'followers' | 'following',
    params: ListConnectionsParams,
    executor: DbExecutor,
  ): Promise<SocialConnectionListRecord[]> {
    const joinUserCondition =
      direction === 'followers'
        ? eq(follows.followerId, users.id)
        : eq(follows.followeeId, users.id);

    const ownerCondition =
      direction === 'followers'
        ? eq(follows.followeeId, params.targetUserId)
        : eq(follows.followerId, params.targetUserId);

    const conditions = [
      ownerCondition,
      eq(follows.status, 'following'),
      eq(users.status, 'active'),
      isNull(users.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM ${blocks} b
        WHERE (b.blocker_id = ${params.viewerUserId} AND b.blocked_id = ${users.id})
           OR (b.blocker_id = ${users.id} AND b.blocked_id = ${params.viewerUserId})
      )`,
    ];

    if (params.cursor) {
      conditions.push(
        sql`(
          ${follows.createdAt} < CAST(${params.cursor.createdAtIso} AS timestamptz)
          OR (
            ${follows.createdAt} = CAST(${params.cursor.createdAtIso} AS timestamptz)
            AND ${users.publicId} < ${params.cursor.publicId}
          )
        )`,
      );
    }

    if (params.query) {
      const escapedPrefix = `${escapeSqlLikePattern(params.query.toLowerCase())}%`;
      const escapedContains = `%${escapeSqlLikePattern(params.query)}%`;
      conditions.push(
        or(
          sql`${users.handleNormalized} LIKE ${escapedPrefix} ESCAPE '\\'`,
          sql`${users.handleNormalized} ILIKE ${escapedContains} ESCAPE '\\'`,
          sql`${users.fullName} ILIKE ${escapedContains} ESCAPE '\\'`,
        )!,
      );
    }

    const rows = await executor
      .select({
        userId: users.id,
        publicId: users.publicId,
        handle: users.handle,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        isPrivate: users.isPrivate,
        cursorCreatedAtIso: sql<string>`to_char(${follows.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        viewerFollowStatusRaw: sql<string | null>`(
          SELECT vf.status::text FROM ${follows} vf
          WHERE vf.follower_id = ${params.viewerUserId}
            AND vf.followee_id = ${users.id}
          LIMIT 1
        )`,
        followedByRaw: sql<boolean>`EXISTS (
          SELECT 1 FROM ${follows} rf
          WHERE rf.follower_id = ${users.id}
            AND rf.followee_id = ${params.viewerUserId}
            AND rf.status = 'following'
        )`,
      })
      .from(follows)
      .innerJoin(users, joinUserCondition)
      .where(and(...conditions))
      .orderBy(desc(follows.createdAt), desc(users.publicId))
      .limit(params.limit + 1);

    return rows.map((row) => ({
      publicId: row.publicId,
      handle: row.handle,
      fullName: row.fullName,
      avatarUrl: row.avatarUrl,
      isPrivate: row.isPrivate,
      viewerFollowStatus:
        row.userId === params.viewerUserId
          ? 'none'
          : normalizeNullableFollowStatus(row.viewerFollowStatusRaw),
      followedBy: row.userId === params.viewerUserId ? false : Boolean(row.followedByRaw),
      isSelf: row.userId === params.viewerUserId,
      cursorCreatedAtIso: row.cursorCreatedAtIso,
    }));
  }

  /**
   * Danh sách Yêu cầu theo dõi đang chờ gửi tới chính `actorUserId`.
   * Sắp xếp `ORDER BY follows.created_at DESC, users.public_id DESC` và lọc keyset theo `(created_at, public_id)`.
   */
  async listFollowRequests(
    params: ListSimpleSocialParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialFollowRequestRecord[]> {
    const conditions = [
      eq(follows.followeeId, params.actorUserId),
      eq(follows.status, 'requested'),
      eq(users.status, 'active'),
      isNull(users.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM ${blocks} b
        WHERE (b.blocker_id = ${params.actorUserId} AND b.blocked_id = ${users.id})
           OR (b.blocker_id = ${users.id} AND b.blocked_id = ${params.actorUserId})
      )`,
    ];

    if (params.cursor) {
      conditions.push(
        sql`(
          ${follows.createdAt} < CAST(${params.cursor.createdAtIso} AS timestamptz)
          OR (
            ${follows.createdAt} = CAST(${params.cursor.createdAtIso} AS timestamptz)
            AND ${users.publicId} < ${params.cursor.publicId}
          )
        )`,
      );
    }

    const rows = await executor
      .select({
        publicId: users.publicId,
        handle: users.handle,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        isPrivate: users.isPrivate,
        requestedAt: follows.createdAt,
        cursorCreatedAtIso: sql<string>`to_char(${follows.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .where(and(...conditions))
      .orderBy(desc(follows.createdAt), desc(users.publicId))
      .limit(params.limit + 1);

    return rows;
  }

  /**
   * Danh sách tài khoản mà chính `actorUserId` đã chặn.
   * Giữ hiển thị cả tài khoản đang bị khóa/đình chỉ để người dùng luôn có thể bỏ chặn (tránh kẹt danh sách).
   * Sắp xếp `ORDER BY blocks.created_at DESC, users.public_id DESC` và lọc keyset theo `(created_at, public_id)`.
   */
  async listBlockedUsers(
    params: ListSimpleSocialParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialBlockedUserRecord[]> {
    const conditions = [eq(blocks.blockerId, params.actorUserId)];

    if (params.cursor) {
      conditions.push(
        sql`(
          ${blocks.createdAt} < CAST(${params.cursor.createdAtIso} AS timestamptz)
          OR (
            ${blocks.createdAt} = CAST(${params.cursor.createdAtIso} AS timestamptz)
            AND ${users.publicId} < ${params.cursor.publicId}
          )
        )`,
      );
    }

    const rows = await executor
      .select({
        publicId: users.publicId,
        handle: users.handle,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        blockedAt: blocks.createdAt,
        cursorCreatedAtIso: sql<string>`to_char(${blocks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(blocks)
      .innerJoin(users, eq(blocks.blockedId, users.id))
      .where(and(...conditions))
      .orderBy(desc(blocks.createdAt), desc(users.publicId))
      .limit(params.limit + 1);

    return rows;
  }

  /**
   * Khi `blockerId` chặn `blockedId`: nếu tồn tại hội thoại 1-1 giữa 2 người,
   * tự động chuyển trạng thái hộp thư của người chặn sang `'declined'` và ẩn hội thoại.
   */
  async declineDirectConversationOnBlock(
    blockerId: string,
    blockedId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<string | null> {
    const pairKey =
      blockerId < blockedId ? `${blockerId}:${blockedId}` : `${blockedId}:${blockerId}`;
    const convRows = await tx
      .select({
        id: conversations.id,
        publicId: conversations.publicId,
        lastSeq: conversations.lastSeq,
      })
      .from(conversations)
      .where(eq(conversations.directPairKey, pairKey))
      .limit(1);

    const conv = convRows[0];
    if (!conv) {
      return null;
    }

    await tx
      .update(conversationParticipants)
      .set({
        inboxState: 'declined',
        clearedBeforeSeq: conv.lastSeq,
        hiddenAt: now,
      })
      .where(
        and(
          eq(conversationParticipants.conversationId, conv.id),
          eq(conversationParticipants.userId, blockerId),
        ),
      );

    return conv.publicId;
  }
}
