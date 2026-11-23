import 'server-only';

import { and, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';

import { generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DatabaseTransaction, type DbExecutor } from '@/core/db';
import {
  blocks,
  follows,
  userHandleHistory,
  users,
  type UserHandleHistoryRow,
  type UserRow,
} from '@/core/db/schema';
import { escapeSqlLikePattern } from '@/modules/profile/handle';
import type { SocialFollowStatus } from '@/modules/social/social.policy';

export interface SearchUsersParams {
  readonly query: string;
  readonly limit: number;
  readonly viewerUserId: string;
}

export interface SearchUserRecord {
  readonly publicId: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly followStatus?: SocialFollowStatus;
  readonly isOwnProfile?: boolean;
}

export interface UpdateProfileDbParams {
  readonly userId: string;
  readonly fullName?: string;
  readonly handle?: string;
  readonly bio?: string;
  readonly now: Date;
  readonly handleChanged: boolean;
}

export interface UpdateAvatarDbParams {
  readonly userId: string;
  readonly avatarUrl: string | null;
  readonly avatarStorageKey: string | null;
  readonly now: Date;
}

export interface UpdateAvatarDbResult {
  readonly updatedUser: UserRow;
  readonly previousStorageKey: string | null;
}

export class ProfileRepository {
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

  async findUserByHandleNormalized(
    handleNormalized: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor
      .select()
      .from(users)
      .where(eq(users.handleNormalized, handleNormalized))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockUserById(userId: string, tx: DatabaseTransaction): Promise<UserRow | null> {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    return rows[0] ?? null;
  }

  /**
   * Khóa `pg_advisory_xact_lock` theo phạm vi transaction (tương thích hoàn toàn với Neon PgBouncer
   * transaction pooling) nhằm tuần tự hóa 2 request đồng thời tranh chấp cùng 1 `@handle` mới.
   */
  async acquireHandleLock(handleNormalized: string, tx: DatabaseTransaction): Promise<void> {
    const lockKey = `tomato:handle:${handleNormalized}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(CAST(${lockKey} AS text), CAST(0 AS bigint)))`,
    );
  }

  async listRecentHandleChanges(
    userId: string,
    since: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserHandleHistoryRow[]> {
    return executor
      .select()
      .from(userHandleHistory)
      .where(and(eq(userHandleHistory.userId, userId), gt(userHandleHistory.createdAt, since)))
      .orderBy(desc(userHandleHistory.createdAt));
  }

  async isHandleReservedByOtherUser(
    handleNormalized: string,
    excludeUserId: string | null,
    now: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<boolean> {
    const conditions = [
      eq(userHandleHistory.oldHandleNormalized, handleNormalized),
      gt(userHandleHistory.reservedUntil, now),
    ];
    if (excludeUserId) {
      conditions.push(ne(userHandleHistory.userId, excludeUserId));
    }

    const rows = await executor
      .select({ id: userHandleHistory.id })
      .from(userHandleHistory)
      .where(and(...conditions))
      .limit(1);
    return rows.length > 0;
  }

  async recordHandleHistory(
    params: {
      readonly userId: string;
      readonly oldHandleNormalized: string;
      readonly reservedUntil: Date;
      readonly createdAt: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx.insert(userHandleHistory).values({
      id: generateUuidV7(),
      userId: params.userId,
      oldHandleNormalized: params.oldHandleNormalized,
      reservedUntil: params.reservedUntil,
      createdAt: params.createdAt,
    });
  }

  async updateUserProfile(
    params: UpdateProfileDbParams,
    tx: DatabaseTransaction,
  ): Promise<UserRow | null> {
    const patch: Partial<typeof users.$inferInsert> = {
      updatedAt: params.now,
    };

    if (params.fullName !== undefined) {
      patch.fullName = params.fullName;
    }
    if (params.bio !== undefined) {
      patch.bio = params.bio;
    }
    if (params.handle !== undefined) {
      patch.handle = params.handle;
      patch.handleNormalized = params.handle;
      // Giữ đồng bộ 1-1 với cột `username` từ Giai đoạn 1.
      patch.username = params.handle;
      if (params.handleChanged) {
        patch.handleChangedAt = params.now;
      }
    }

    const rows = await tx.update(users).set(patch).where(eq(users.id, params.userId)).returning();

    return rows[0] ?? null;
  }

  async updateUserAvatarAtomic(params: UpdateAvatarDbParams): Promise<UpdateAvatarDbResult | null> {
    return this.getDefaultDb().transaction(async (tx) => {
      const locked = await this.lockUserById(params.userId, tx);
      if (!locked || locked.status !== 'active' || locked.deletedAt !== null) {
        return null;
      }

      const rows = await tx
        .update(users)
        .set({
          avatarUrl: params.avatarUrl,
          avatarStorageKey: params.avatarStorageKey,
          updatedAt: params.now,
        })
        .where(eq(users.id, params.userId))
        .returning();

      const updatedUser = rows[0];
      if (!updatedUser) {
        return null;
      }

      return {
        updatedUser,
        previousStorageKey: locked.avatarStorageKey,
      };
    });
  }

  /**
   * Tìm kiếm người dùng tối ưu chỉ trên bảng `users` (tuyệt đối KHÔNG join email `auth_identities`):
   * - Chỉ trả các tài khoản đang `active`, chưa bị xóa (`deleted_at IS NULL`),
   *   và KHÔNG có quan hệ chặn hai chiều với `viewerUserId`.
   * - Xếp hạng ưu tiên:
   *   0: Khớp chính xác `@handle`
   *   1: Khớp tiền tố `@handle` (`LIKE prefix%` — dùng B-Tree `varchar_pattern_ops`)
   *   2: Khớp tên hiển thị `full_name` (`ILIKE` hoặc tương đồng `pg_trgm` — dùng GIN `gin_trgm_ops`)
   */
  async searchActiveUsers(
    params: SearchUsersParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SearchUserRecord[]> {
    const queryLower = params.query.toLowerCase();
    const escapedPrefix = `${escapeSqlLikePattern(queryLower)}%`;
    const escapedContains = `%${escapeSqlLikePattern(params.query)}%`;

    const rankExpr = sql<number>`CASE
      WHEN ${users.handleNormalized} = ${queryLower} THEN 0
      WHEN ${users.handleNormalized} LIKE ${escapedPrefix} ESCAPE '\\' THEN 1
      ELSE 2
    END`;

    const similarityExpr = sql<number>`GREATEST(
      similarity(${users.fullName}, ${params.query}),
      similarity(${users.handleNormalized}, ${queryLower})
    )`;

    const rows = await executor
      .select({
        userId: users.id,
        publicId: users.publicId,
        handle: users.handle,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        isPrivate: users.isPrivate,
        followStatusRaw: sql<string | null>`(
          SELECT f.status::text FROM ${follows} f
          WHERE f.follower_id = ${params.viewerUserId}
            AND f.followee_id = ${users.id}
          LIMIT 1
        )`,
      })
      .from(users)
      .where(
        and(
          eq(users.status, 'active'),
          isNull(users.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${blocks} b
            WHERE (b.blocker_id = ${params.viewerUserId} AND b.blocked_id = ${users.id})
               OR (b.blocker_id = ${users.id} AND b.blocked_id = ${params.viewerUserId})
          )`,
          or(
            eq(users.handleNormalized, queryLower),
            sql`${users.handleNormalized} LIKE ${escapedPrefix} ESCAPE '\\'`,
            sql`${users.fullName} ILIKE ${escapedContains} ESCAPE '\\'`,
            sql`similarity(${users.fullName}, ${params.query}) >= 0.25`,
          ),
        ),
      )
      .orderBy(rankExpr, desc(similarityExpr), users.handleNormalized)
      .limit(params.limit);

    return rows.map((row) => {
      const isOwnProfile = row.userId === params.viewerUserId;
      const followStatus: SocialFollowStatus =
        !isOwnProfile &&
        (row.followStatusRaw === 'following' || row.followStatusRaw === 'requested')
          ? row.followStatusRaw
          : 'none';
      return {
        publicId: row.publicId,
        handle: row.handle,
        fullName: row.fullName,
        avatarUrl: row.avatarUrl,
        isPrivate: row.isPrivate,
        followStatus,
        isOwnProfile,
      };
    });
  }
}
