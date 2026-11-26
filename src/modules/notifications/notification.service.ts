import 'server-only';

import type { DatabaseTransaction } from '@/core/db';
import type { NotificationType, UserRow } from '@/core/db/schema';
import { logger } from '@/core/logger';
import {
  getRealtimeProvider,
  type RealtimeEventName,
  type RealtimeProvider,
} from '@/core/realtime';
import { NOTIFICATION_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { formatZodErrorDetails } from '@/core/security/http-response';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { NotificationDomainError } from '@/modules/notifications/notification.errors';
import { NOTIFICATION_MESSAGES } from '@/modules/notifications/notification.messages';
import { assertNotificationAuthorized } from '@/modules/notifications/notification.policy';
import {
  NotificationRepository,
  buildNotificationDedupeKey,
} from '@/modules/notifications/notification.repository';
import {
  deleteNotificationQuerySchema,
  encodeNotificationCursor,
  markNotificationsReadInputSchema,
  notificationListQuerySchema,
  notificationPublicIdParamSchema,
} from '@/modules/notifications/notification.schemas';

/**
 * DTO allowlist cho tác nhân trong mỗi thông báo.
 * Tuyệt đối không lộ `id` (UUIDv7), `email` hay `avatarStorageKey`.
 */
export interface NotificationActorDto {
  readonly public_id: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly isPrivate: boolean;
}

/**
 * DTO allowlist cho mỗi dòng thông báo trả qua REST và đẩy qua Realtime (Ably/SSE).
 */
export interface NotificationItemDto {
  readonly public_id: string;
  readonly type: NotificationType;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly entityPublicId: string | null;
  readonly actor: NotificationActorDto;
  readonly followRequestPending: boolean;
}

export interface NotificationListResult {
  readonly items: readonly NotificationItemDto[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export interface MarkNotificationsReadResult {
  readonly markedCount: number;
  readonly unreadCount: number;
}

export interface DeleteNotificationResult {
  readonly deleted: true;
  readonly notificationPublicId: string;
  readonly unreadCount: number;
}

export interface PendingRealtimeDispatch {
  readonly recipientPublicId: string;
  readonly eventName: RealtimeEventName;
  readonly payload: Record<string, unknown>;
}

export interface DeferredBatchNotificationRecord {
  readonly recipientId: string;
  readonly recipientPublicId: string;
  readonly notification: NotificationItemDto;
}

export type NotificationUserSummary = Pick<
  UserRow,
  'id' | 'publicId' | 'handle' | 'fullName' | 'avatarUrl' | 'isPrivate' | 'status' | 'deletedAt'
>;

export interface NotificationServiceDependencies {
  readonly repository?: NotificationRepository;
  readonly rateLimiter?: Pick<RateLimiter, 'consume'>;
  readonly realtimeProvider?: RealtimeProvider;
  readonly now?: () => Date;
}

export class NotificationService {
  private readonly repository: NotificationRepository;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly realtimeProvider: RealtimeProvider;
  private readonly now: () => Date;

  constructor(deps: NotificationServiceDependencies = {}) {
    this.repository = deps.repository ?? new NotificationRepository();
    this.rateLimiter = deps.rateLimiter ?? getRateLimiter();
    this.realtimeProvider = deps.realtimeProvider ?? getRealtimeProvider();
    this.now = deps.now ?? (() => new Date());
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof NOTIFICATION_RATE_LIMITS)[keyof typeof NOTIFICATION_RATE_LIMITS],
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new NotificationDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: NOTIFICATION_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  async listNotifications(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
    options: { readonly skipRateLimit?: boolean } = {},
  ): Promise<NotificationListResult> {
    assertNotificationAuthorized(actor, 'notification:list');
    if (!options.skipRateLimit) {
      await this.consumeRateLimitOrThrow(
        `notifications:list:user:${actor.user.id}`,
        NOTIFICATION_RATE_LIMITS.listByUser,
      );
    }

    const parsed = notificationListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new NotificationDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: NOTIFICATION_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const [rows, unreadCount] = await Promise.all([
      this.repository.listForRecipient({
        recipientUserId: actor.user.id,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      }),
      this.repository.countUnreadForRecipient(actor.user.id),
    ]);

    const hasMore = rows.length > parsed.data.limit;
    const pageRows = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map((row) => ({
        public_id: row.publicId,
        type: row.type,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt ? row.readAt.toISOString() : null,
        entityPublicId: row.entityPublicId,
        actor: {
          public_id: row.actorPublicId,
          handle: row.actorHandle,
          fullName: row.actorFullName,
          avatarUrl: row.actorAvatarUrl,
          isPrivate: row.actorIsPrivate,
        },
        followRequestPending: row.followRequestPending,
      })),
      unreadCount,
      nextCursor:
        hasMore && lastRow
          ? encodeNotificationCursor({
              createdAtIso: lastRow.cursorCreatedAtIso,
              publicId: lastRow.publicId,
            })
          : null,
    };
  }

  async markNotificationsRead(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<MarkNotificationsReadResult> {
    assertNotificationAuthorized(actor, 'notification:mark_read');
    await this.consumeRateLimitOrThrow(
      `notifications:read:user:${actor.user.id}`,
      NOTIFICATION_RATE_LIMITS.markReadByUser,
    );

    const parsed = markNotificationsReadInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new NotificationDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: NOTIFICATION_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const currentTime = this.now();
    const markedPublicIds = await this.repository.markReadForRecipient(
      actor.user.id,
      {
        markAll: parsed.data.markAll === true,
        notificationPublicIds: parsed.data.notificationPublicIds,
      },
      currentTime,
    );
    const unreadCount = await this.repository.countUnreadForRecipient(actor.user.id);

    // Đồng bộ trạng thái đã đọc tới các tab khác của chính người dùng.
    if (markedPublicIds.length > 0) {
      await this.dispatchRealtimeEvents([
        {
          recipientPublicId: actor.user.publicId,
          eventName: 'notification.read',
          payload: {
            markAll: parsed.data.markAll === true,
            notificationPublicIds: markedPublicIds,
            unreadCount,
          },
        },
      ]);
    }

    return {
      markedCount: markedPublicIds.length,
      unreadCount,
    };
  }

  /**
   * Xóa cứng 1 thông báo thuộc chính người dùng hiện tại (`actor.user.id` từ Access Token):
   * - Chỉ xóa dòng thông báo hiển thị; TUYỆT ĐỐI KHÔNG làm thay đổi trạng thái follow/unfollow/block.
   * - Kiểm tra quyền sở hữu qua Policy ReBAC tập trung + scope truy vấn `recipient_id = actor.user.id`.
   * - Trả đồng nhất `404 Not Found` khi thông báo không tồn tại hoặc thuộc về người khác.
   * - Phát sự kiện `notification.deleted` chỉ tới kênh cá nhân `user:{actor.publicId}` sau khi commit.
   */
  async deleteNotification(
    actor: AuthenticatedPrincipal,
    rawNotificationPublicId: string,
    rawQuery: Record<string, unknown> = {},
  ): Promise<DeleteNotificationResult> {
    assertNotificationAuthorized(actor, 'notification:delete');
    await this.consumeRateLimitOrThrow(
      `notifications:delete:user:${actor.user.id}`,
      NOTIFICATION_RATE_LIMITS.deleteByUser,
    );

    const parsedQuery = deleteNotificationQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new NotificationDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: NOTIFICATION_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedQuery.error),
      });
    }

    const parsedPublicId = notificationPublicIdParamSchema.safeParse(rawNotificationPublicId);
    if (!parsedPublicId.success) {
      throw new NotificationDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: NOTIFICATION_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsedPublicId.error),
      });
    }

    const targetPublicId = parsedPublicId.data;

    const txOutcome = await this.repository.getDb().transaction(async (tx) => {
      const deleted = await this.repository.deleteOneForRecipient(
        actor.user.id,
        targetPublicId,
        tx,
      );

      // Fail-closed: nếu không tồn tại hoặc thuộc người khác -> Policy ném 404 đồng nhất.
      assertNotificationAuthorized(actor, 'notification:delete', {
        notificationRecipientId: deleted?.recipientId ?? null,
      });

      const unreadCount = await this.repository.countUnreadForRecipient(actor.user.id, tx);
      return {
        notificationPublicId: deleted!.publicId,
        unreadCount,
      };
    });

    await this.dispatchRealtimeEvents([
      {
        recipientPublicId: actor.user.publicId,
        eventName: 'notification.deleted',
        payload: {
          notificationPublicId: txOutcome.notificationPublicId,
          unreadCount: txOutcome.unreadCount,
        },
      },
    ]);

    return {
      deleted: true,
      notificationPublicId: txOutcome.notificationPublicId,
      unreadCount: txOutcome.unreadCount,
    };
  }

  /**
   * Tạo/dedupe thông báo trong cùng DB transaction của nghiệp vụ nguồn (Follow/Accept/Message Request)
   * và trả về sự kiện Realtime đã lọc DTO an toàn để đẩy sau khi transaction commit.
   */
  async recordNotificationInTx(
    tx: DatabaseTransaction,
    params: {
      readonly recipient: NotificationUserSummary;
      readonly actor: NotificationUserSummary;
      readonly type: NotificationType;
      readonly entityPublicId?: string | null;
      readonly now?: Date;
    },
  ): Promise<PendingRealtimeDispatch | null> {
    if (
      params.recipient.id === params.actor.id ||
      params.recipient.status !== 'active' ||
      params.recipient.deletedAt !== null ||
      params.actor.status !== 'active' ||
      params.actor.deletedAt !== null
    ) {
      return null;
    }

    const currentTime = params.now ?? this.now();
    const dedupeKey = buildNotificationDedupeKey(
      params.type,
      params.actor.id,
      params.entityPublicId,
    );

    const saved = await this.repository.upsertUnreadNotification(
      {
        recipientId: params.recipient.id,
        actorId: params.actor.id,
        type: params.type,
        entityPublicId: params.entityPublicId ?? params.actor.publicId,
        dedupeKey,
        now: currentTime,
      },
      tx,
    );

    const unreadCount = await this.repository.countUnreadForRecipient(params.recipient.id, tx);

    const dto: NotificationItemDto = {
      public_id: saved.publicId,
      type: saved.type,
      createdAt: saved.createdAt.toISOString(),
      readAt: saved.readAt ? saved.readAt.toISOString() : null,
      entityPublicId: saved.entityPublicId,
      actor: {
        public_id: params.actor.publicId,
        handle: params.actor.handle,
        fullName: params.actor.fullName,
        avatarUrl: params.actor.avatarUrl,
        isPrivate: params.actor.isPrivate,
      },
      followRequestPending: saved.type === 'follow_request',
    };

    return {
      recipientPublicId: params.recipient.publicId,
      eventName: 'notification.created',
      payload: {
        notification: dto,
        unreadCount,
      },
    };
  }

  /**
   * Ghi hàng loạt thông báo trong DB transaction bằng 1 câu `INSERT ... ON CONFLICT` duy nhất
   * (KHÔNG chạy N câu đếm `unreadCount` khi đang giữ khóa `FOR UPDATE` trên nhiều dòng `users`).
   * Sau khi transaction commit, gọi `buildBatchCreatedDispatches` để đếm `GROUP BY recipient_id` 1 lần.
   */
  async recordNotificationsBatchInTx(
    tx: DatabaseTransaction,
    params: {
      readonly recipients: readonly NotificationUserSummary[];
      readonly actor: NotificationUserSummary;
      readonly type: NotificationType;
      readonly entityPublicId?: string | null;
      readonly now?: Date;
    },
  ): Promise<{
    readonly immediateDispatches: PendingRealtimeDispatch[];
    readonly deferredRecords: DeferredBatchNotificationRecord[];
  }> {
    if (params.actor.status !== 'active' || params.actor.deletedAt !== null) {
      return { immediateDispatches: [], deferredRecords: [] };
    }

    const eligibleRecipients = params.recipients.filter(
      (r) => r.id !== params.actor.id && r.status === 'active' && r.deletedAt === null,
    );
    if (eligibleRecipients.length === 0) {
      return { immediateDispatches: [], deferredRecords: [] };
    }

    // Tương thích ngược với các unit test truyền partial mock repository chỉ có `upsertUnreadNotification`.
    if (
      typeof this.repository.upsertUnreadNotificationsBatch !== 'function' ||
      typeof this.repository.countUnreadForRecipients !== 'function'
    ) {
      const immediateDispatches: PendingRealtimeDispatch[] = [];
      for (const recipient of eligibleRecipients) {
        const d = await this.recordNotificationInTx(tx, {
          recipient,
          actor: params.actor,
          type: params.type,
          entityPublicId: params.entityPublicId,
          now: params.now,
        });
        if (d) {
          immediateDispatches.push(d);
        }
      }
      return { immediateDispatches, deferredRecords: [] };
    }

    const currentTime = params.now ?? this.now();
    const dedupeKey = buildNotificationDedupeKey(
      params.type,
      params.actor.id,
      params.entityPublicId,
    );
    const entityPublicId = params.entityPublicId ?? params.actor.publicId;

    const recipientById = new Map<string, NotificationUserSummary>();
    for (const r of eligibleRecipients) {
      recipientById.set(r.id, r);
    }

    const savedRows = await this.repository.upsertUnreadNotificationsBatch(
      Array.from(recipientById.values()).map((recipient) => ({
        recipientId: recipient.id,
        actorId: params.actor.id,
        type: params.type,
        entityPublicId,
        dedupeKey,
        now: currentTime,
      })),
      tx,
    );

    const actorDto: NotificationActorDto = {
      public_id: params.actor.publicId,
      handle: params.actor.handle,
      fullName: params.actor.fullName,
      avatarUrl: params.actor.avatarUrl,
      isPrivate: params.actor.isPrivate,
    };

    const deferredRecords: DeferredBatchNotificationRecord[] = [];
    for (const saved of savedRows) {
      const recipient = recipientById.get(saved.recipientId);
      if (!recipient) {
        continue;
      }
      deferredRecords.push({
        recipientId: recipient.id,
        recipientPublicId: recipient.publicId,
        notification: {
          public_id: saved.publicId,
          type: saved.type,
          createdAt: saved.createdAt.toISOString(),
          readAt: saved.readAt ? saved.readAt.toISOString() : null,
          entityPublicId: saved.entityPublicId,
          actor: actorDto,
          followRequestPending: saved.type === 'follow_request',
        },
      });
    }

    return { immediateDispatches: [], deferredRecords };
  }

  /**
   * Thực thi ngoài DB transaction `FOR UPDATE` (sau khi commit):
   * gom đếm `unreadCount` cho toàn bộ người nhận bằng 1 câu `GROUP BY recipient_id` duy nhất.
   */
  async buildBatchCreatedDispatches(
    records: readonly DeferredBatchNotificationRecord[],
  ): Promise<PendingRealtimeDispatch[]> {
    if (records.length === 0) {
      return [];
    }

    const countsByRecipient = await this.repository.countUnreadForRecipients(
      records.map((r) => r.recipientId),
    );

    return records.map((record) => ({
      recipientPublicId: record.recipientPublicId,
      eventName: 'notification.created',
      payload: {
        notification: record.notification,
        unreadCount: countsByRecipient.get(record.recipientId) ?? 0,
      },
    }));
  }

  async removeFollowRequestNotificationsInTx(
    tx: DatabaseTransaction,
    params: {
      readonly recipientId: string;
      readonly recipientPublicId: string;
      readonly actorIds: readonly string[];
    },
  ): Promise<PendingRealtimeDispatch | null> {
    const deletedPublicIds = await this.repository.deleteByRecipientActorsAndType(
      params.recipientId,
      params.actorIds,
      'follow_request',
      tx,
    );
    if (deletedPublicIds.length === 0) {
      return null;
    }

    const unreadCount = await this.repository.countUnreadForRecipient(params.recipientId, tx);
    return {
      recipientPublicId: params.recipientPublicId,
      eventName: 'notification.removed',
      payload: {
        notificationPublicIds: deletedPublicIds,
        unreadCount,
      },
    };
  }

  async removeMessageRequestNotificationsInTx(
    tx: DatabaseTransaction,
    params: {
      readonly recipientId: string;
      readonly recipientPublicId: string;
      readonly actorIds: readonly string[];
    },
  ): Promise<PendingRealtimeDispatch | null> {
    const deletedPublicIds = await this.repository.deleteByRecipientActorsAndType(
      params.recipientId,
      params.actorIds,
      'message_request',
      tx,
    );
    if (deletedPublicIds.length === 0) {
      return null;
    }

    const unreadCount = await this.repository.countUnreadForRecipient(params.recipientId, tx);
    return {
      recipientPublicId: params.recipientPublicId,
      eventName: 'notification.removed',
      payload: {
        notificationPublicIds: deletedPublicIds,
        unreadCount,
      },
    };
  }

  /**
   * Khi A chặn B:
   * - Xóa sạch thông báo của cả 2 phía trong PostgreSQL ngay trong transaction.
   * - Chỉ đồng bộ gỡ trên giao diện của A (người chặn); IM LẶNG TUYỆT ĐỐI với B (không đẩy sự kiện cho B).
   */
  async purgeNotificationsOnBlockInTx(
    tx: DatabaseTransaction,
    params: {
      readonly blockerId: string;
      readonly blockerPublicId: string;
      readonly blockedId: string;
    },
  ): Promise<PendingRealtimeDispatch | null> {
    const { deletedForA } = await this.repository.deleteAllBetweenUsers(
      params.blockerId,
      params.blockedId,
      tx,
    );
    if (deletedForA.length === 0) {
      return null;
    }

    const unreadCount = await this.repository.countUnreadForRecipient(params.blockerId, tx);
    return {
      recipientPublicId: params.blockerPublicId,
      eventName: 'notification.removed',
      payload: {
        notificationPublicIds: deletedForA,
        unreadCount,
      },
    };
  }

  /**
   * Đẩy các sự kiện Realtime theo cơ chế best-effort sau khi DB transaction đã commit:
   * lỗi mạng tạm thời tới Ably không làm thất bại thao tác nghiệp vụ chính.
   */
  async dispatchRealtimeEvents(events: readonly (PendingRealtimeDispatch | null)[]): Promise<void> {
    const validEvents = events.filter((e): e is PendingRealtimeDispatch => e !== null);
    if (validEvents.length === 0) {
      return;
    }

    await Promise.all(
      validEvents.map(async (event) => {
        try {
          await this.realtimeProvider.publishToUser(
            event.recipientPublicId,
            event.eventName,
            event.payload,
          );
        } catch (error) {
          const errObj =
            typeof error === 'object' && error !== null
              ? (error as { readonly code?: unknown; readonly name?: unknown })
              : null;
          logger.warn(
            {
              component: 'notifications-realtime',
              eventName: event.eventName,
              errorCode:
                typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
                  ? errObj.code
                  : 'PUBLISH_FAILED',
              errorName: typeof errObj?.name === 'string' ? errObj.name : 'Error',
            },
            'Không thể đẩy sự kiện thông báo Realtime (DB đã lưu thành công)',
          );
        }
      }),
    );
  }
}

export function createNotificationService(
  deps: NotificationServiceDependencies = {},
): NotificationService {
  return new NotificationService(deps);
}

const globalForNotifications = globalThis as typeof globalThis & {
  __tomatoNotificationService?: NotificationService;
};

export function getNotificationService(): NotificationService {
  if (!globalForNotifications.__tomatoNotificationService) {
    globalForNotifications.__tomatoNotificationService = createNotificationService();
  }
  return globalForNotifications.__tomatoNotificationService;
}

export function setNotificationServiceForTesting(service: NotificationService): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setNotificationServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForNotifications.__tomatoNotificationService = service;
}

export function resetNotificationServiceForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetNotificationServiceForTesting chỉ được phép gọi trong môi trường test');
  }
  globalForNotifications.__tomatoNotificationService = undefined;
}
