import 'server-only';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { getDb, type Database, type DbExecutor } from '@/core/db';
import {
  blocks,
  follows,
  notifications,
  users,
  type NotificationRow,
  type NotificationType,
} from '@/core/db/schema';
import type { NotificationKeysetCursor } from '@/modules/notifications/notification.schemas';

export interface NotificationFeedRecord {
  readonly publicId: string;
  readonly type: NotificationType;
  readonly entityPublicId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly cursorCreatedAtIso: string;
  readonly actorPublicId: string;
  readonly actorHandle: string;
  readonly actorFullName: string;
  readonly actorAvatarUrl: string | null;
  readonly actorIsPrivate: boolean;
  readonly followRequestPending: boolean;
}

export interface UpsertNotificationParams {
  readonly recipientId: string;
  readonly actorId: string;
  readonly type: NotificationType;
  readonly entityPublicId?: string | null;
  readonly dedupeKey: string;
  readonly now: Date;
}

export interface ListNotificationsParams {
  readonly recipientUserId: string;
  readonly limit: number;
  readonly cursor?: NotificationKeysetCursor;
}

export function buildNotificationDedupeKey(
  type: NotificationType,
  actorId: string,
  entityPublicId?: string | null,
): string {
  switch (type) {
    case 'follow_request':
      return `follow_request:${actorId}`;
    case 'follow_accepted':
      return `follow_accepted:${actorId}`;
    case 'new_follower':
      return `new_follower:${actorId}`;
    case 'message_request':
      return `message_request:${entityPublicId ?? actorId}`;
  }
}

export class NotificationRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  getDb(): Database {
    return this.getDefaultDb();
  }

  /**
   * Chèn hoặc cập nhật chống trùng lặp thông báo chưa đọc nhờ partial unique index
   * `uq_notifications_recipient_dedupe_unread (recipient_id, dedupe_key) WHERE read_at IS NULL`.
   */
  async upsertUnreadNotification(
    params: UpsertNotificationParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<NotificationRow> {
    const rows = await executor
      .insert(notifications)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        recipientId: params.recipientId,
        actorId: params.actorId,
        type: params.type,
        entityPublicId: params.entityPublicId ?? null,
        dedupeKey: params.dedupeKey,
        readAt: null,
        createdAt: params.now,
      })
      .onConflictDoUpdate({
        target: [notifications.recipientId, notifications.dedupeKey],
        targetWhere: sql`read_at IS NULL`,
        set: {
          entityPublicId: params.entityPublicId ?? null,
          createdAt: params.now,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error('Không thể tạo bản ghi thông báo.');
    }
    return row;
  }

  /**
   * Chèn hoặc cập nhật chống trùng lặp nhiều thông báo chưa đọc trong 1 câu SQL duy nhất
   * (phục vụ duyệt hàng loạt lời mời theo dõi khi chuyển tài khoản Riêng tư -> Công khai).
   */
  async upsertUnreadNotificationsBatch(
    items: readonly UpsertNotificationParams[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<NotificationRow[]> {
    if (items.length === 0) {
      return [];
    }

    // Khử trùng theo (recipient_id, dedupe_key) để PostgreSQL ON CONFLICT DO UPDATE không chạm cùng 1 dòng 2 lần.
    const dedupedByKey = new Map<string, UpsertNotificationParams>();
    for (const item of items) {
      dedupedByKey.set(`${item.recipientId}|${item.dedupeKey}`, item);
    }
    const uniqueItems = Array.from(dedupedByKey.values());

    return executor
      .insert(notifications)
      .values(
        uniqueItems.map((params) => ({
          id: generateUuidV7(),
          publicId: generatePublicId(),
          recipientId: params.recipientId,
          actorId: params.actorId,
          type: params.type,
          entityPublicId: params.entityPublicId ?? null,
          dedupeKey: params.dedupeKey,
          readAt: null,
          createdAt: params.now,
        })),
      )
      .onConflictDoUpdate({
        target: [notifications.recipientId, notifications.dedupeKey],
        targetWhere: sql`read_at IS NULL`,
        set: {
          entityPublicId: sql`excluded.entity_public_id`,
          createdAt: sql`excluded.created_at`,
        },
      })
      .returning();
  }

  async deleteByRecipientActorsAndType(
    recipientId: string,
    actorIds: readonly string[],
    type: NotificationType,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<string[]> {
    const uniqueActorIds = Array.from(new Set(actorIds));
    if (uniqueActorIds.length === 0) {
      return [];
    }

    const rows = await executor
      .delete(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          inArray(notifications.actorId, uniqueActorIds),
          eq(notifications.type, type),
        ),
      )
      .returning({ publicId: notifications.publicId });

    return rows.map((row) => row.publicId);
  }

  /**
   * Xóa sạch toàn bộ thông báo hai chiều giữa A và B khi phát sinh sự kiện chặn.
   */
  async deleteAllBetweenUsers(
    userAId: string,
    userBId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{ readonly deletedForA: string[]; readonly deletedForB: string[] }> {
    const rows = await executor
      .delete(notifications)
      .where(
        or(
          and(eq(notifications.recipientId, userAId), eq(notifications.actorId, userBId)),
          and(eq(notifications.recipientId, userBId), eq(notifications.actorId, userAId)),
        ),
      )
      .returning({
        recipientId: notifications.recipientId,
        publicId: notifications.publicId,
      });

    const deletedForA: string[] = [];
    const deletedForB: string[] = [];
    for (const row of rows) {
      if (row.recipientId === userAId) {
        deletedForA.push(row.publicId);
      } else if (row.recipientId === userBId) {
        deletedForB.push(row.publicId);
      }
    }
    return { deletedForA, deletedForB };
  }

  async listForRecipient(
    params: ListNotificationsParams,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<NotificationFeedRecord[]> {
    const conditions = [
      eq(notifications.recipientId, params.recipientUserId),
      eq(users.status, 'active'),
      isNull(users.deletedAt),
      // Phòng thủ chiều sâu: luôn ẩn thông báo từ tài khoản có quan hệ chặn hai chiều.
      sql`NOT EXISTS (
        SELECT 1 FROM ${blocks} b
        WHERE (b.blocker_id = ${params.recipientUserId} AND b.blocked_id = ${users.id})
           OR (b.blocker_id = ${users.id} AND b.blocked_id = ${params.recipientUserId})
      )`,
    ];

    if (params.cursor) {
      conditions.push(
        sql`(
          ${notifications.createdAt} < CAST(${params.cursor.createdAtIso} AS timestamptz)
          OR (
            ${notifications.createdAt} = CAST(${params.cursor.createdAtIso} AS timestamptz)
            AND ${notifications.publicId} < ${params.cursor.publicId}
          )
        )`,
      );
    }

    const rows = await executor
      .select({
        publicId: notifications.publicId,
        type: notifications.type,
        entityPublicId: notifications.entityPublicId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        cursorCreatedAtIso: sql<string>`to_char(${notifications.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        actorPublicId: users.publicId,
        actorHandle: users.handle,
        actorFullName: users.fullName,
        actorAvatarUrl: users.avatarUrl,
        actorIsPrivate: users.isPrivate,
        followRequestPendingRaw: sql<boolean>`(
          ${notifications.type} = 'follow_request'
          AND EXISTS (
            SELECT 1 FROM ${follows} f
            WHERE f.follower_id = ${users.id}
              AND f.followee_id = ${params.recipientUserId}
              AND f.status = 'requested'
          )
        )`,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.actorId, users.id))
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.publicId))
      .limit(params.limit + 1);

    return rows.map((row) => ({
      publicId: row.publicId,
      type: row.type,
      entityPublicId: row.entityPublicId,
      readAt: row.readAt,
      createdAt: row.createdAt,
      cursorCreatedAtIso: row.cursorCreatedAtIso,
      actorPublicId: row.actorPublicId,
      actorHandle: row.actorHandle,
      actorFullName: row.actorFullName,
      actorAvatarUrl: row.actorAvatarUrl,
      actorIsPrivate: row.actorIsPrivate,
      followRequestPending: Boolean(row.followRequestPendingRaw),
    }));
  }

  async countUnreadForRecipient(
    recipientUserId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<number> {
    const rows = await executor
      .select({
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.actorId, users.id))
      .where(
        and(
          eq(notifications.recipientId, recipientUserId),
          isNull(notifications.readAt),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${blocks} b
            WHERE (b.blocker_id = ${recipientUserId} AND b.blocked_id = ${users.id})
               OR (b.blocker_id = ${users.id} AND b.blocked_id = ${recipientUserId})
          )`,
        ),
      );

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Đếm số lượng thông báo chưa đọc theo lô cho nhiều `recipientUserIds` khác nhau
   * bằng 1 truy vấn `GROUP BY recipient_id` duy nhất (ngoài transaction `FOR UPDATE`).
   */
  async countUnreadForRecipients(
    recipientUserIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Map<string, number>> {
    const uniqueIds = Array.from(new Set(recipientUserIds));
    const countsByRecipient = new Map<string, number>();
    if (uniqueIds.length === 0) {
      return countsByRecipient;
    }
    for (const id of uniqueIds) {
      countsByRecipient.set(id, 0);
    }

    const rows = await executor
      .select({
        recipientId: notifications.recipientId,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.actorId, users.id))
      .where(
        and(
          inArray(notifications.recipientId, uniqueIds),
          isNull(notifications.readAt),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${blocks} b
            WHERE (b.blocker_id = ${notifications.recipientId} AND b.blocked_id = ${users.id})
               OR (b.blocker_id = ${users.id} AND b.blocked_id = ${notifications.recipientId})
          )`,
        ),
      )
      .groupBy(notifications.recipientId);

    for (const row of rows) {
      countsByRecipient.set(row.recipientId, Number(row.count ?? 0));
    }

    return countsByRecipient;
  }

  async markReadForRecipient(
    recipientUserId: string,
    options: { readonly markAll?: boolean; readonly notificationPublicIds?: readonly string[] },
    now: Date,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<string[]> {
    const conditions = [
      eq(notifications.recipientId, recipientUserId),
      isNull(notifications.readAt),
    ];

    if (!options.markAll) {
      const uniqueIds = Array.from(new Set(options.notificationPublicIds ?? []));
      if (uniqueIds.length === 0) {
        return [];
      }
      conditions.push(inArray(notifications.publicId, uniqueIds));
    }

    const rows = await executor
      .update(notifications)
      .set({ readAt: now })
      .where(and(...conditions))
      .returning({ publicId: notifications.publicId });

    return rows.map((row) => row.publicId);
  }

  /**
   * Xóa cứng đúng 1 thông báo thuộc chính `recipientUserId` theo cặp `(public_id, recipient_id)`.
   * Tuyệt đối không tác động tới bảng `follows` hay `blocks`.
   */
  async deleteOneForRecipient(
    recipientUserId: string,
    notificationPublicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{
    readonly publicId: string;
    readonly recipientId: string;
    readonly readAt: Date | null;
  } | null> {
    const rows = await executor
      .delete(notifications)
      .where(
        and(
          eq(notifications.publicId, notificationPublicId),
          eq(notifications.recipientId, recipientUserId),
        ),
      )
      .returning({
        publicId: notifications.publicId,
        recipientId: notifications.recipientId,
        readAt: notifications.readAt,
      });

    return rows[0] ?? null;
  }
}
