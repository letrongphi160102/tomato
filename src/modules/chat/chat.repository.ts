import 'server-only';

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import {
  getDb,
  withRlsContext,
  type Database,
  type DatabaseTransaction,
  type DbExecutor,
} from '@/core/db';
import {
  authIdentities,
  blocks,
  conversationParticipants,
  conversations,
  follows,
  messageAttachments,
  messagePins,
  messageReactions,
  messageUserDeletions,
  messages,
  userE2eeDevices,
  userE2eeKeyBackups,
  users,
  type AttachmentMediaKind,
  type ConversationInboxState,
  type ConversationParticipantRow,
  type ConversationRow,
  type E2eeBackupKdfParamsRecord,
  type E2eePublicJwkRecord,
  type MessageAttachmentRow,
  type MessageCryptoHeaderRecord,
  type MessagePinRow,
  type MessageReactionRow,
  type MessageRow,
  type MessageType,
  type UserE2eeDeviceRow,
  type UserE2eeKeyBackupRow,
  type UserRow,
} from '@/core/db/schema';
import {
  EMPTY_SOCIAL_RELATIONSHIP,
  type SocialFollowStatus,
  type SocialRelationshipSnapshot,
} from '@/modules/social/social.policy';

export function buildDirectPairKey(userAId: string, userBId: string): string {
  const a = userAId.trim().toLowerCase();
  const b = userBId.trim().toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function normalizeFollowStatus(raw: string | null | undefined): SocialFollowStatus {
  if (raw === 'following' || raw === 'requested') {
    return raw;
  }
  return 'none';
}

export interface ConversationListRowRecord {
  readonly conversation: ConversationRow;
  readonly actorParticipant: ConversationParticipantRow;
  readonly peerParticipant: ConversationParticipantRow;
  readonly peerUser: Pick<
    UserRow,
    | 'id'
    | 'publicId'
    | 'handle'
    | 'fullName'
    | 'avatarUrl'
    | 'isPrivate'
    | 'showReadReceipts'
    | 'status'
    | 'deletedAt'
  >;
  readonly lastMessage: {
    readonly row: MessageRow;
    readonly senderPublicId: string;
  } | null;
}

export class ChatRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  getDb(): Database {
    return this.getDefaultDb();
  }

  async runInRlsTx<T>(
    actorUserId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return withRlsContext(actorUserId, callback, this.getDefaultDb());
  }

  async getDatabaseNow(tx: DatabaseTransaction): Promise<Date> {
    const result = await tx.execute<{ readonly db_now: Date | string }>(
      sql`SELECT NOW() AS db_now`,
    );
    const raw = result.rows[0]?.db_now;
    if (raw instanceof Date) {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return new Date();
  }

  async findUserByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.publicId, publicId)).limit(1);
    return rows[0] ?? null;
  }

  async findUserById(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ?? null;
  }

  async findVerifiedEmailForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<string | null> {
    const rows = await executor
      .select({
        email: authIdentities.identifierNormalized,
      })
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.userId, userId),
          eq(authIdentities.provider, 'email_password'),
          isNotNull(authIdentities.verifiedAt),
        ),
      )
      .limit(1);
    return rows[0]?.email ?? null;
  }

  async lockUsersInCanonicalOrder(
    userIds: readonly string[],
    tx: DatabaseTransaction,
  ): Promise<Map<string, UserRow>> {
    const sortedIds = Array.from(new Set(userIds)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

  async getRelationshipSnapshot(
    actorUserId: string,
    targetUserId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialRelationshipSnapshot> {
    if (actorUserId === targetUserId) {
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
            and(eq(blocks.blockerId, actorUserId), eq(blocks.blockedId, targetUserId)),
            and(eq(blocks.blockerId, targetUserId), eq(blocks.blockedId, actorUserId)),
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
            and(eq(follows.followerId, actorUserId), eq(follows.followeeId, targetUserId)),
            and(eq(follows.followerId, targetUserId), eq(follows.followeeId, actorUserId)),
          ),
        ),
    ]);

    let blockedByActor = false;
    let blockedByTarget = false;
    for (const row of blockRows) {
      if (row.blockerId === actorUserId && row.blockedId === targetUserId) {
        blockedByActor = true;
      } else if (row.blockerId === targetUserId && row.blockedId === actorUserId) {
        blockedByTarget = true;
      }
    }

    let actorFollowStatus: SocialFollowStatus = 'none';
    let targetFollowStatus: SocialFollowStatus = 'none';
    for (const row of followRows) {
      if (row.followerId === actorUserId && row.followeeId === targetUserId) {
        actorFollowStatus = normalizeFollowStatus(row.status);
      } else if (row.followerId === targetUserId && row.followeeId === actorUserId) {
        targetFollowStatus = normalizeFollowStatus(row.status);
      }
    }

    return {
      blockedByActor,
      blockedByTarget,
      actorFollowStatus,
      targetFollowStatus,
    };
  }

  /**
   * Đọc đồng thời thông tin `users` của đối phương và snapshot quan hệ xã hội 2 chiều
   * chỉ trong 1 câu SQL duy nhất (tiết kiệm 2 round-trip mạng bên trong transaction RLS).
   */
  async findUserWithRelationshipById(
    actorUserId: string,
    targetUserId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{
    readonly user: UserRow;
    readonly relationship: SocialRelationshipSnapshot;
  } | null> {
    if (actorUserId === targetUserId) {
      const user = await this.findUserById(targetUserId, executor);
      return user ? { user, relationship: EMPTY_SOCIAL_RELATIONSHIP } : null;
    }

    const rows = await executor
      .select({
        ...getTableColumns(users),
        relBlockedByActor: sql<boolean>`EXISTS (
          SELECT 1 FROM ${blocks} b
          WHERE b.blocker_id = ${actorUserId} AND b.blocked_id = ${targetUserId}
        )`,
        relBlockedByTarget: sql<boolean>`EXISTS (
          SELECT 1 FROM ${blocks} b
          WHERE b.blocker_id = ${targetUserId} AND b.blocked_id = ${actorUserId}
        )`,
        relActorFollowStatus: sql<string | null>`(
          SELECT f.status::text FROM ${follows} f
          WHERE f.follower_id = ${actorUserId} AND f.followee_id = ${targetUserId}
          LIMIT 1
        )`,
        relTargetFollowStatus: sql<string | null>`(
          SELECT f.status::text FROM ${follows} f
          WHERE f.follower_id = ${targetUserId} AND f.followee_id = ${actorUserId}
          LIMIT 1
        )`,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    const match = rows[0];
    if (!match) {
      return null;
    }

    const {
      relBlockedByActor,
      relBlockedByTarget,
      relActorFollowStatus,
      relTargetFollowStatus,
      ...user
    } = match;

    return {
      user,
      relationship: {
        blockedByActor: Boolean(relBlockedByActor),
        blockedByTarget: Boolean(relBlockedByTarget),
        actorFollowStatus: normalizeFollowStatus(relActorFollowStatus),
        targetFollowStatus: normalizeFollowStatus(relTargetFollowStatus),
      },
    };
  }

  // =========================================================================
  // E2EE Device Keys & PIN Backups
  // =========================================================================

  async listActiveDevicesForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserE2eeDeviceRow[]> {
    // Luôn ưu tiên Khóa Đồng bộ (`is_sync_key = true`) lên đầu danh sách để không bao giờ bị cắt mất ở giới hạn 10 thiết bị.
    return executor
      .select()
      .from(userE2eeDevices)
      .where(and(eq(userE2eeDevices.userId, userId), isNull(userE2eeDevices.revokedAt)))
      .orderBy(
        desc(userE2eeDevices.isSyncKey),
        desc(userE2eeDevices.lastSeenAt),
        desc(userE2eeDevices.createdAt),
        asc(userE2eeDevices.id),
      );
  }

  async listHistoricalRevokedDevicesForUser(
    userId: string,
    limit: number = 50,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserE2eeDeviceRow[]> {
    return executor
      .select()
      .from(userE2eeDevices)
      .where(and(eq(userE2eeDevices.userId, userId), isNotNull(userE2eeDevices.revokedAt)))
      .orderBy(desc(userE2eeDevices.revokedAt), desc(userE2eeDevices.createdAt))
      .limit(limit);
  }

  async markDeviceAsSyncKeyByFingerprint(
    params: {
      readonly userId: string;
      readonly keyFingerprint: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<UserE2eeDeviceRow | null> {
    // Gỡ cờ sync key và thu hồi mọi khóa đồng bộ cũ khác dấu vân tay trước khi gán khóa đồng bộ mới (tôn trọng UNIQUE partial index).
    await tx
      .update(userE2eeDevices)
      .set({
        isSyncKey: false,
        revokedAt: params.now,
      })
      .where(
        and(
          eq(userE2eeDevices.userId, params.userId),
          eq(userE2eeDevices.isSyncKey, true),
          ne(userE2eeDevices.keyFingerprint, params.keyFingerprint),
        ),
      );

    const updated = await tx
      .update(userE2eeDevices)
      .set({
        isSyncKey: true,
        revokedAt: null,
        lastSeenAt: params.now,
      })
      .where(
        and(
          eq(userE2eeDevices.userId, params.userId),
          eq(userE2eeDevices.keyFingerprint, params.keyFingerprint),
        ),
      )
      .returning();

    return updated[0] ?? null;
  }

  async upsertUserE2eeDevice(
    params: {
      readonly userId: string;
      readonly sessionFamilyId: string | null;
      readonly deviceLabel: string;
      readonly identityPublicKeyJwk: E2eePublicJwkRecord;
      readonly signingPublicKeyJwk: E2eePublicJwkRecord;
      readonly keyFingerprint: string;
      readonly isSyncKey?: boolean;
      readonly maxActiveDevices: number;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<{
    readonly device: UserE2eeDeviceRow;
    readonly revokedDevicePublicIds: readonly string[];
  }> {
    const isSyncKey = params.isSyncKey === true;

    if (isSyncKey) {
      // Đảm bảo chỉ có tối đa 1 Khóa Đồng bộ hoạt động trên mỗi tài khoản (tuân thủ UNIQUE partial index).
      await tx
        .update(userE2eeDevices)
        .set({
          isSyncKey: false,
          revokedAt: params.now,
        })
        .where(
          and(
            eq(userE2eeDevices.userId, params.userId),
            eq(userE2eeDevices.isSyncKey, true),
            ne(userE2eeDevices.keyFingerprint, params.keyFingerprint),
          ),
        );
    }

    const upsertedRows = await tx
      .insert(userE2eeDevices)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        userId: params.userId,
        sessionFamilyId: params.sessionFamilyId,
        deviceLabel: params.deviceLabel,
        identityPublicKeyJwk: params.identityPublicKeyJwk,
        signingPublicKeyJwk: params.signingPublicKeyJwk,
        keyFingerprint: params.keyFingerprint,
        isSyncKey,
        revokedAt: null,
        lastSeenAt: params.now,
        createdAt: params.now,
      })
      .onConflictDoUpdate({
        target: [userE2eeDevices.userId, userE2eeDevices.keyFingerprint],
        set: {
          sessionFamilyId: params.sessionFamilyId,
          deviceLabel: params.deviceLabel,
          identityPublicKeyJwk: params.identityPublicKeyJwk,
          signingPublicKeyJwk: params.signingPublicKeyJwk,
          // Bảo toàn cờ `is_sync_key` nếu thiết bị đã là khóa đồng bộ trước đó.
          isSyncKey: isSyncKey ? true : sql`${userE2eeDevices.isSyncKey}`,
          revokedAt: null,
          lastSeenAt: params.now,
        },
      })
      .returning();

    const currentDevice = upsertedRows[0]!;

    // Kiểm tra tổng số thiết bị đang hoạt động của user; nếu vượt quá `maxActiveDevices` (10),
    // tự động thu hồi các thiết bị cũ nhất (tuyệt đối KHÔNG thu hồi Khóa Đồng bộ PIN).
    const activeDevices = await tx
      .select()
      .from(userE2eeDevices)
      .where(and(eq(userE2eeDevices.userId, params.userId), isNull(userE2eeDevices.revokedAt)))
      .orderBy(
        desc(userE2eeDevices.isSyncKey),
        desc(userE2eeDevices.lastSeenAt),
        desc(userE2eeDevices.createdAt),
      );

    const revokedDevicePublicIds: string[] = [];
    if (activeDevices.length > params.maxActiveDevices) {
      const backupRow = await this.findKeyBackupByUserId(params.userId, tx);
      const backupFingerprint = backupRow?.keyFingerprint ?? null;

      const removable = activeDevices.filter(
        (d) => d.id !== currentDevice.id && !d.isSyncKey && d.keyFingerprint !== backupFingerprint,
      );
      const excessCount = activeDevices.length - params.maxActiveDevices;
      const toRevoke = removable.slice(-excessCount);

      if (toRevoke.length > 0) {
        const revokeIds = toRevoke.map((d) => d.id);
        await tx
          .update(userE2eeDevices)
          .set({ revokedAt: params.now })
          .where(inArray(userE2eeDevices.id, revokeIds));
        revokedDevicePublicIds.push(...toRevoke.map((d) => d.publicId));
      }
    }

    return {
      device: currentDevice,
      revokedDevicePublicIds,
    };
  }

  async findKeyBackupByUserId(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserE2eeKeyBackupRow | null> {
    const rows = await executor
      .select()
      .from(userE2eeKeyBackups)
      .where(eq(userE2eeKeyBackups.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertKeyBackup(
    params: {
      readonly userId: string;
      readonly encryptedKeyBlob: string;
      readonly kdfSalt: string;
      readonly kdfParams: E2eeBackupKdfParamsRecord;
      readonly iv: string;
      readonly keyFingerprint: string;
      readonly version: number;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<UserE2eeKeyBackupRow> {
    const rows = await tx
      .insert(userE2eeKeyBackups)
      .values({
        userId: params.userId,
        encryptedKeyBlob: params.encryptedKeyBlob,
        kdfSalt: params.kdfSalt,
        kdfParams: params.kdfParams,
        iv: params.iv,
        keyFingerprint: params.keyFingerprint,
        version: params.version,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [userE2eeKeyBackups.userId],
        set: {
          encryptedKeyBlob: params.encryptedKeyBlob,
          kdfSalt: params.kdfSalt,
          kdfParams: params.kdfParams,
          iv: params.iv,
          keyFingerprint: params.keyFingerprint,
          version: params.version,
          updatedAt: params.now,
        },
      })
      .returning();

    return rows[0]!;
  }

  // =========================================================================
  // Conversations & Participants
  // =========================================================================

  async findConversationByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationRow | null> {
    const rows = await executor
      .select()
      .from(conversations)
      .where(eq(conversations.publicId, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findConversationById(
    conversationId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationRow | null> {
    const rows = await executor
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockConversationByPublicId(
    publicId: string,
    tx: DatabaseTransaction,
  ): Promise<ConversationRow | null> {
    const rows = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.publicId, publicId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async lockConversationById(
    conversationId: string,
    tx: DatabaseTransaction,
  ): Promise<ConversationRow | null> {
    const rows = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async findConversationByDirectPairKey(
    directPairKey: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationRow | null> {
    const rows = await executor
      .select()
      .from(conversations)
      .where(eq(conversations.directPairKey, directPairKey))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertOrLockDirectConversation(
    directPairKey: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<{ readonly conversation: ConversationRow; readonly isNewlyCreated: boolean }> {
    const inserted = await tx
      .insert(conversations)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        type: 'direct',
        directPairKey,
        lastSeq: 0,
        lastMessageAt: null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [conversations.directPairKey] })
      .returning();

    if (inserted[0]) {
      return { conversation: inserted[0], isNewlyCreated: true };
    }

    const lockedRows = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.directPairKey, directPairKey))
      .limit(1)
      .for('update');

    if (!lockedRows[0]) {
      throw new Error('Không thể lấy hoặc khóa cuộc trò chuyện 1-1.');
    }

    return { conversation: lockedRows[0], isNewlyCreated: false };
  }

  async listConversationParticipants(
    conversationId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationParticipantRow[]> {
    return executor
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId));
  }

  async lockConversationParticipants(
    conversationId: string,
    tx: DatabaseTransaction,
  ): Promise<ConversationParticipantRow[]> {
    return tx
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(conversationParticipants.userId))
      .for('update');
  }

  async insertConversationParticipants(
    rows: readonly {
      readonly conversationId: string;
      readonly userId: string;
      readonly inboxState: ConversationInboxState;
      readonly pendingMessagesSent: number;
      readonly joinedAt: Date;
    }[],
    tx: DatabaseTransaction,
  ): Promise<ConversationParticipantRow[]> {
    return tx
      .insert(conversationParticipants)
      .values(
        rows.map((r) => ({
          conversationId: r.conversationId,
          userId: r.userId,
          inboxState: r.inboxState,
          pendingMessagesSent: r.pendingMessagesSent,
          lastReadSeq: 0,
          clearedBeforeSeq: 0,
          hiddenAt: null,
          joinedAt: r.joinedAt,
        })),
      )
      .returning();
  }

  async updateParticipantState(
    conversationId: string,
    userId: string,
    patch: Partial<
      Pick<
        ConversationParticipantRow,
        | 'inboxState'
        | 'pendingMessagesSent'
        | 'lastReadSeq'
        | 'clearedBeforeSeq'
        | 'hiddenAt'
        | 'pinnedAt'
        | 'mutedAt'
      >
    >,
    tx: DatabaseTransaction,
  ): Promise<ConversationParticipantRow | null> {
    const rows = await tx
      .update(conversationParticipants)
      .set(patch)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async resetAllParticipantsPendingCount(
    conversationId: string,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(conversationParticipants)
      .set({ pendingMessagesSent: 0 })
      .where(eq(conversationParticipants.conversationId, conversationId));
  }

  async advanceParticipantLastReadSeq(
    params: {
      readonly conversationId: string;
      readonly userId: string;
      readonly targetSeq: number;
      readonly conversationLastSeq: number;
    },
    tx: DatabaseTransaction,
  ): Promise<ConversationParticipantRow | null> {
    const safeClampedSeq = Math.max(0, Math.min(params.targetSeq, params.conversationLastSeq));
    const rows = await tx
      .update(conversationParticipants)
      .set({
        lastReadSeq: sql`GREATEST(${conversationParticipants.lastReadSeq}, ${safeClampedSeq})`,
      })
      .where(
        and(
          eq(conversationParticipants.conversationId, params.conversationId),
          eq(conversationParticipants.userId, params.userId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Xóa đoạn hội thoại ở phía riêng `actor`:
   * Chỉ cập nhật `cleared_before_seq = GREATEST(cleared_before_seq, last_seq)` và `hidden_at = now`.
   * TUYỆT ĐỐI KHÔNG tăng `last_read_seq` để không bao giờ làm đối phương nhìn thấy nhãn "Đã xem" giả.
   */
  async clearAndHideConversationForUser(
    params: {
      readonly conversationId: string;
      readonly userId: string;
      readonly conversationLastSeq: number;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<ConversationParticipantRow | null> {
    const safeLastSeq = Math.max(0, params.conversationLastSeq);
    const rows = await tx
      .update(conversationParticipants)
      .set({
        clearedBeforeSeq: sql`GREATEST(${conversationParticipants.clearedBeforeSeq}, ${safeLastSeq})`,
        hiddenAt: params.now,
        // Tự động giải phóng suất ghim đoạn chat khi người dùng xóa cuộc trò chuyện ở phía mình.
        pinnedAt: null,
      })
      .where(
        and(
          eq(conversationParticipants.conversationId, params.conversationId),
          eq(conversationParticipants.userId, params.userId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async countUnreadPrimaryConversationsForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<number> {
    const rows = await executor
      .select({
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(conversationParticipants)
      .innerJoin(conversations, eq(conversationParticipants.conversationId, conversations.id))
      .where(
        and(
          eq(conversationParticipants.userId, userId),
          eq(conversationParticipants.inboxState, 'primary'),
          isNull(conversationParticipants.hiddenAt),
          // Cuộc trò chuyện đã tắt thông báo không cộng vào tổng badge đỏ chưa đọc.
          isNull(conversationParticipants.mutedAt),
          gt(conversations.lastSeq, conversationParticipants.clearedBeforeSeq),
          sql`EXISTS (
            SELECT 1
            FROM ${conversationParticipants} peer_cp
            INNER JOIN ${users} peer_u ON peer_u.id = peer_cp.user_id
            WHERE peer_cp.conversation_id = ${conversations.id}
              AND peer_cp.user_id <> ${userId}
              AND peer_u.status = 'active'
              AND peer_u.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${blocks} b
                WHERE (b.blocker_id = ${userId} AND b.blocked_id = peer_u.id)
                   OR (b.blocker_id = peer_u.id AND b.blocked_id = ${userId})
              )
          )`,
          sql`EXISTS (
            SELECT 1
            FROM ${messages} m
            WHERE m.conversation_id = ${conversations.id}
              AND m.sender_id <> ${userId}
              AND NOT EXISTS (
                SELECT 1
                FROM ${messageUserDeletions} mud
                WHERE mud.message_id = m.id
                  AND mud.user_id = ${userId}
              )
              AND m.seq > GREATEST(
                ${conversationParticipants.lastReadSeq},
                ${conversationParticipants.clearedBeforeSeq},
                COALESCE(
                  (
                    SELECT MAX(own_m.seq)
                    FROM ${messages} own_m
                    WHERE own_m.conversation_id = ${conversations.id}
                      AND own_m.sender_id = ${userId}
                  ),
                  0
                )
              )
          )`,
        ),
      );

    return Number(rows[0]?.count ?? 0);
  }

  async countPendingConversationsForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<number> {
    const rows = await executor
      .select({
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(conversationParticipants)
      .innerJoin(conversations, eq(conversationParticipants.conversationId, conversations.id))
      .where(
        and(
          eq(conversationParticipants.userId, userId),
          eq(conversationParticipants.inboxState, 'pending'),
          isNull(conversationParticipants.hiddenAt),
          gt(conversations.lastSeq, conversationParticipants.clearedBeforeSeq),
          sql`EXISTS (
            SELECT 1
            FROM ${conversationParticipants} peer_cp
            INNER JOIN ${users} peer_u ON peer_u.id = peer_cp.user_id
            WHERE peer_cp.conversation_id = ${conversations.id}
              AND peer_cp.user_id <> ${userId}
              AND peer_u.status = 'active'
              AND peer_u.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${blocks} b
                WHERE (b.blocker_id = ${userId} AND b.blocked_id = peer_u.id)
                   OR (b.blocker_id = peer_u.id AND b.blocked_id = ${userId})
              )
          )`,
        ),
      );

    return Number(rows[0]?.count ?? 0);
  }

  async findLatestVisibleMessageForConversation(
    params: {
      readonly conversationId: string;
      readonly viewerUserId: string;
      readonly clearedBeforeSeq: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{ readonly row: MessageRow; readonly senderPublicId: string } | null> {
    const msgRows = await executor
      .select({
        row: messages,
        senderPublicId: users.publicId,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(
        and(
          eq(messages.conversationId, params.conversationId),
          gt(messages.seq, params.clearedBeforeSeq),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${messageUserDeletions} mud
            WHERE mud.message_id = ${messages.id}
              AND mud.user_id = ${params.viewerUserId}
          )`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(1);

    return msgRows[0] ?? null;
  }

  /**
   * Truy vấn gộp (batch `DISTINCT ON (m.conversation_id)`) lấy tin nhắn hiển thị mới nhất
   * cho danh sách hội thoại chỉ bằng 1 câu SQL duy nhất:
   * - Bắt buộc giữ `m.seq > cp.cleared_before_seq` riêng của từng hội thoại (chống lộ lại tin trước mốc Xóa đoạn chat).
   * - Bắt buộc giữ `NOT EXISTS message_user_deletions` (ẩn tin đã xóa 1 phía).
   */
  async findLatestVisibleMessagesForConversations(
    params: {
      readonly conversationIds: readonly string[];
      readonly viewerUserId: string;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Map<string, { readonly row: MessageRow; readonly senderPublicId: string }>> {
    const uniqueConvIds = Array.from(new Set(params.conversationIds));
    if (uniqueConvIds.length === 0) {
      return new Map();
    }

    const msgRows = await executor
      .selectDistinctOn([messages.conversationId], {
        row: messages,
        senderPublicId: users.publicId,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, messages.conversationId),
          eq(conversationParticipants.userId, params.viewerUserId),
        ),
      )
      .where(
        and(
          inArray(messages.conversationId, uniqueConvIds),
          gt(messages.seq, conversationParticipants.clearedBeforeSeq),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${messageUserDeletions} mud
            WHERE mud.message_id = ${messages.id}
              AND mud.user_id = ${params.viewerUserId}
          )`,
        ),
      )
      .orderBy(messages.conversationId, desc(messages.seq));

    const map = new Map<string, { readonly row: MessageRow; readonly senderPublicId: string }>();
    for (const item of msgRows) {
      map.set(item.row.conversationId, item);
    }
    return map;
  }

  async listConversationsForUser(
    params: {
      readonly userId: string;
      readonly tab: 'primary' | 'pending';
      readonly limit: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationListRowRecord[]> {
    const myParticipations = await executor
      .select({
        participant: conversationParticipants,
        conversation: conversations,
      })
      .from(conversationParticipants)
      .innerJoin(conversations, eq(conversationParticipants.conversationId, conversations.id))
      .where(
        and(
          eq(conversationParticipants.userId, params.userId),
          eq(conversationParticipants.inboxState, params.tab),
          isNull(conversationParticipants.hiddenAt),
          // Chỉ hiển thị trong danh sách hộp thư những cuộc trò chuyện có tin nhắn mới hơn mốc đã xóa của bản thân.
          gt(conversations.lastSeq, conversationParticipants.clearedBeforeSeq),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${conversationParticipants.pinnedAt} IS NOT NULL THEN 0 ELSE 1 END ASC`,
        desc(conversationParticipants.pinnedAt),
        desc(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`),
        desc(conversations.createdAt),
      )
      .limit(params.limit + 1);

    if (myParticipations.length === 0) {
      return [];
    }

    const convIds = myParticipations.map((r) => r.conversation.id);
    const peerRows = await executor
      .select({
        participant: conversationParticipants,
        user: {
          id: users.id,
          publicId: users.publicId,
          handle: users.handle,
          fullName: users.fullName,
          avatarUrl: users.avatarUrl,
          isPrivate: users.isPrivate,
          showReadReceipts: users.showReadReceipts,
          status: users.status,
          deletedAt: users.deletedAt,
        },
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(conversationParticipants.userId, users.id))
      .where(
        and(
          inArray(conversationParticipants.conversationId, convIds),
          ne(conversationParticipants.userId, params.userId),
        ),
      );

    const peerByConvId = new Map<
      string,
      {
        readonly participant: ConversationParticipantRow;
        readonly user: ConversationListRowRecord['peerUser'];
      }
    >();
    const peerUserIds: string[] = [];

    for (const row of peerRows) {
      peerByConvId.set(row.participant.conversationId, row);
      peerUserIds.push(row.user.id);
    }

    // Lọc bỏ các hội thoại mà đối phương đã bị chặn / chặn mình hoặc tài khoản không hoạt động.
    const blockedPeerIds = new Set<string>();
    if (peerUserIds.length > 0) {
      const blockRows = await executor
        .select({
          blockerId: blocks.blockerId,
          blockedId: blocks.blockedId,
        })
        .from(blocks)
        .where(
          or(
            and(eq(blocks.blockerId, params.userId), inArray(blocks.blockedId, peerUserIds)),
            and(inArray(blocks.blockerId, peerUserIds), eq(blocks.blockedId, params.userId)),
          ),
        );
      for (const b of blockRows) {
        blockedPeerIds.add(b.blockerId === params.userId ? b.blockedId : b.blockerId);
      }
    }

    const eligibleItems: Array<{
      readonly conversation: ConversationRow;
      readonly participant: ConversationParticipantRow;
      readonly peerInfo: {
        readonly participant: ConversationParticipantRow;
        readonly user: ConversationListRowRecord['peerUser'];
      };
    }> = [];
    const convIdsNeedingPreview: string[] = [];

    for (const item of myParticipations) {
      const peerInfo = peerByConvId.get(item.conversation.id);
      if (!peerInfo) {
        continue;
      }
      if (
        peerInfo.user.status !== 'active' ||
        peerInfo.user.deletedAt !== null ||
        blockedPeerIds.has(peerInfo.user.id)
      ) {
        continue;
      }

      eligibleItems.push({
        conversation: item.conversation,
        participant: item.participant,
        peerInfo,
      });
      if (item.conversation.lastSeq > item.participant.clearedBeforeSeq) {
        convIdsNeedingPreview.push(item.conversation.id);
      }
    }

    const latestMessagesByConvId =
      convIdsNeedingPreview.length > 0
        ? await this.findLatestVisibleMessagesForConversations(
            {
              conversationIds: convIdsNeedingPreview,
              viewerUserId: params.userId,
            },
            executor,
          )
        : new Map<string, { readonly row: MessageRow; readonly senderPublicId: string }>();

    return eligibleItems.map((item) => ({
      conversation: item.conversation,
      actorParticipant: item.participant,
      peerParticipant: item.peerInfo.participant,
      peerUser: item.peerInfo.user,
      lastMessage: latestMessagesByConvId.get(item.conversation.id) ?? null,
    }));
  }

  // =========================================================================
  // Messages
  // =========================================================================

  async findMessageByClientMsgId(
    conversationId: string,
    senderId: string,
    clientMsgId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<MessageRow | null> {
    const rows = await executor
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderId, senderId),
          eq(messages.clientMsgId, clientMsgId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertMessageAndIncrementSeq(
    params: {
      readonly conversationId: string;
      readonly nextSeq: number;
      readonly senderId: string;
      readonly clientMsgId: string;
      readonly messageType: MessageType;
      readonly ciphertext: string;
      readonly cryptoHeader: MessageCryptoHeaderRecord;
      readonly attachmentStorageKey?: string | null;
      readonly replyToMessageId?: string | null;
      readonly isForwarded?: boolean;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageRow> {
    await tx
      .update(conversations)
      .set({
        lastSeq: params.nextSeq,
        lastMessageAt: params.now,
      })
      .where(eq(conversations.id, params.conversationId));

    const inserted = await tx
      .insert(messages)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        conversationId: params.conversationId,
        senderId: params.senderId,
        seq: params.nextSeq,
        clientMsgId: params.clientMsgId,
        messageType: params.messageType,
        ciphertext: params.ciphertext,
        cryptoHeader: params.cryptoHeader,
        attachmentStorageKey: params.attachmentStorageKey ?? null,
        replyToMessageId: params.replyToMessageId ?? null,
        isForwarded: params.isForwarded === true,
        editCount: 0,
        editedAt: null,
        recalledAt: null,
        createdAt: params.now,
      })
      .returning();

    return inserted[0]!;
  }

  async findMessageByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{ readonly row: MessageRow; readonly senderPublicId: string } | null> {
    const rows = await executor
      .select({
        row: messages,
        senderPublicId: users.publicId,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messages.publicId, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockMessageByPublicId(
    publicId: string,
    tx: DatabaseTransaction,
  ): Promise<MessageRow | null> {
    const rows = await tx
      .select()
      .from(messages)
      .where(eq(messages.publicId, publicId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async isMessageDeletedForUser(
    messageId: string,
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<boolean> {
    const rows = await executor
      .select({ messageId: messageUserDeletions.messageId })
      .from(messageUserDeletions)
      .where(
        and(eq(messageUserDeletions.messageId, messageId), eq(messageUserDeletions.userId, userId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  async updateEditedMessageAtomically(
    params: {
      readonly messageId: string;
      readonly senderId: string;
      readonly ciphertext: string;
      readonly cryptoHeader: MessageCryptoHeaderRecord;
      readonly maxEditCount: number;
      readonly editWindowSeconds: number;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageRow | null> {
    const rows = await tx
      .update(messages)
      .set({
        ciphertext: params.ciphertext,
        cryptoHeader: params.cryptoHeader,
        editCount: sql`${messages.editCount} + 1`,
        editedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(messages.id, params.messageId),
          eq(messages.senderId, params.senderId),
          eq(messages.messageType, 'text'),
          isNull(messages.recalledAt),
          lt(messages.editCount, params.maxEditCount),
          sql`(NOW() - ${messages.createdAt}) <= (${params.editWindowSeconds} * interval '1 second')`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async recallMessageAtomically(
    params: {
      readonly messageId: string;
      readonly senderId: string;
      readonly recallWindowSeconds: number;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageRow | null> {
    const rows = await tx
      .update(messages)
      .set({
        ciphertext: null,
        cryptoHeader: null,
        attachmentStorageKey: null,
        recalledAt: sql`NOW()`,
      })
      .where(
        and(
          eq(messages.id, params.messageId),
          eq(messages.senderId, params.senderId),
          ne(messages.messageType, 'call_event'),
          isNull(messages.recalledAt),
          sql`(NOW() - ${messages.createdAt}) <= (${params.recallWindowSeconds} * interval '1 second')`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async insertMessageUserDeletion(
    params: {
      readonly messageId: string;
      readonly userId: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .insert(messageUserDeletions)
      .values({
        messageId: params.messageId,
        userId: params.userId,
        deletedAt: params.now,
      })
      .onConflictDoNothing({
        target: [messageUserDeletions.messageId, messageUserDeletions.userId],
      });
  }

  async listMessagesForConversation(
    params: {
      readonly conversationId: string;
      readonly viewerUserId?: string;
      readonly clearedBeforeSeq: number;
      readonly limit: number;
      readonly cursorSeq?: number;
      readonly afterSeq?: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Array<{ readonly row: MessageRow; readonly senderPublicId: string }>> {
    const minSeq = Math.max(params.clearedBeforeSeq, params.afterSeq ?? 0);
    const conditions = [
      eq(messages.conversationId, params.conversationId),
      gt(messages.seq, minSeq),
    ];

    if (params.viewerUserId) {
      conditions.push(
        sql`NOT EXISTS (
          SELECT 1
          FROM ${messageUserDeletions} mud
          WHERE mud.message_id = ${messages.id}
            AND mud.user_id = ${params.viewerUserId}
        )`,
      );
    }

    if (params.cursorSeq !== undefined) {
      conditions.push(lt(messages.seq, params.cursorSeq));
    }

    // Nếu delta-sync qua `afterSeq`, trả theo thứ tự tăng dần; nếu tải lịch sử qua `cursorSeq`, lấy mới nhất trước rồi đảo lại.
    const isForwardDelta = params.afterSeq !== undefined && params.cursorSeq === undefined;

    const rows = await executor
      .select({
        row: messages,
        senderPublicId: users.publicId,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(and(...conditions))
      .orderBy(isForwardDelta ? asc(messages.seq) : desc(messages.seq))
      .limit(params.limit + 1);

    return rows;
  }

  // =========================================================================
  // Encrypted Media Attachments (M11)
  // =========================================================================

  async insertPendingAttachment(
    params: {
      readonly conversationId: string;
      readonly uploaderId: string;
      readonly mediaKind: AttachmentMediaKind;
      readonly storageKey: string;
      readonly ciphertextSizeBytes: number;
      readonly ciphertextSha256: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow> {
    const rows = await tx
      .insert(messageAttachments)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        conversationId: params.conversationId,
        uploaderId: params.uploaderId,
        messageId: null,
        mediaKind: params.mediaKind,
        storageKey: params.storageKey,
        storageUrl: null,
        ciphertextSizeBytes: params.ciphertextSizeBytes,
        ciphertextSha256: params.ciphertextSha256,
        deletedAt: null,
        createdAt: params.now,
      })
      .returning();
    return rows[0]!;
  }

  async findAttachmentByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<MessageAttachmentRow | null> {
    const rows = await executor
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.publicId, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockAttachmentByPublicId(
    publicId: string,
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow | null> {
    const rows = await tx
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.publicId, publicId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async markAttachmentStorageUrlUploaded(
    params: {
      readonly attachmentId: string;
      readonly uploaderId: string;
      readonly storageUrl: string;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow | null> {
    const rows = await tx
      .update(messageAttachments)
      .set({
        storageUrl: params.storageUrl,
      })
      .where(
        and(
          eq(messageAttachments.id, params.attachmentId),
          eq(messageAttachments.uploaderId, params.uploaderId),
          isNull(messageAttachments.messageId),
          isNull(messageAttachments.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async bindAttachmentToMessageAtomically(
    params: {
      readonly attachmentId: string;
      readonly conversationId: string;
      readonly uploaderId: string;
      readonly messageId: string;
      readonly storageUrl: string;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow | null> {
    const rows = await tx
      .update(messageAttachments)
      .set({
        messageId: params.messageId,
        storageUrl: params.storageUrl,
      })
      .where(
        and(
          eq(messageAttachments.id, params.attachmentId),
          eq(messageAttachments.conversationId, params.conversationId),
          eq(messageAttachments.uploaderId, params.uploaderId),
          isNull(messageAttachments.messageId),
          isNull(messageAttachments.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async findActiveAttachmentByMessageId(
    messageId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<MessageAttachmentRow | null> {
    const rows = await executor
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async softDeleteAttachmentsByMessageId(
    params: {
      readonly messageId: string;
      readonly uploaderId: string;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow[]> {
    return tx
      .update(messageAttachments)
      .set({
        deletedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(messageAttachments.messageId, params.messageId),
          eq(messageAttachments.uploaderId, params.uploaderId),
          isNull(messageAttachments.deletedAt),
        ),
      )
      .returning();
  }

  /**
   * Đánh dấu và lấy tối đa `limit` bản ghi pending quá hạn (`message_id IS NULL`) của chính `uploaderId`
   * để dọn tệp rác trên Storage theo cơ chế lazy cleanup không đua tranh.
   */
  async claimExpiredPendingAttachmentsForUser(
    params: {
      readonly uploaderId: string;
      readonly cutoffDate: Date;
      readonly limit: number;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageAttachmentRow[]> {
    const candidates = await tx
      .select({ id: messageAttachments.id })
      .from(messageAttachments)
      .where(
        and(
          eq(messageAttachments.uploaderId, params.uploaderId),
          isNull(messageAttachments.messageId),
          isNull(messageAttachments.deletedAt),
          lt(messageAttachments.createdAt, params.cutoffDate),
        ),
      )
      .orderBy(asc(messageAttachments.createdAt))
      .limit(params.limit)
      .for('update');

    if (candidates.length === 0) {
      return [];
    }

    const ids = candidates.map((row) => row.id);
    return tx
      .update(messageAttachments)
      .set({
        deletedAt: sql`NOW()`,
      })
      .where(and(inArray(messageAttachments.id, ids), isNull(messageAttachments.deletedAt)))
      .returning();
  }

  // =========================================================================
  // M13 — Reactions, Message Pins, Reply Metadata, Conversation Preferences & Forward Targets
  // =========================================================================

  async countPinnedPrimaryConversationsForUser(
    userId: string,
    tx: DatabaseTransaction,
  ): Promise<number> {
    const rows = await tx
      .select({
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.userId, userId),
          eq(conversationParticipants.inboxState, 'primary'),
          isNull(conversationParticipants.hiddenAt),
          isNotNull(conversationParticipants.pinnedAt),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  async upsertMessageReaction(
    params: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly userId: string;
      readonly emoji: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<MessageReactionRow> {
    const rows = await tx
      .insert(messageReactions)
      .values({
        conversationId: params.conversationId,
        messageId: params.messageId,
        userId: params.userId,
        emoji: params.emoji,
        createdAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [messageReactions.messageId, messageReactions.userId],
        set: {
          emoji: params.emoji,
          updatedAt: params.now,
        },
      })
      .returning();
    return rows[0]!;
  }

  async deleteMessageReaction(
    messageId: string,
    userId: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const deleted = await tx
      .delete(messageReactions)
      .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId)))
      .returning({ messageId: messageReactions.messageId });
    return deleted.length > 0;
  }

  async deleteAllReactionsForMessage(messageId: string, tx: DatabaseTransaction): Promise<void> {
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
  }

  async listReactionsForMessageIds(
    conversationId: string,
    messageIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<
    Array<{
      readonly messageId: string;
      readonly userPublicId: string;
      readonly emoji: string;
      readonly updatedAt: Date;
    }>
  > {
    if (messageIds.length === 0) {
      return [];
    }
    return executor
      .select({
        messageId: messageReactions.messageId,
        userPublicId: users.publicId,
        emoji: messageReactions.emoji,
        updatedAt: messageReactions.updatedAt,
      })
      .from(messageReactions)
      .innerJoin(users, eq(messageReactions.userId, users.id))
      .where(
        and(
          eq(messageReactions.conversationId, conversationId),
          inArray(messageReactions.messageId, [...messageIds]),
        ),
      )
      .orderBy(asc(messageReactions.createdAt));
  }

  async findReplyTargetsMetadataByIds(
    params: {
      readonly conversationId: string;
      readonly messageIds: readonly string[];
      readonly viewerUserId: string;
      readonly clearedBeforeSeq: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<
    Map<
      string,
      {
        readonly messagePublicId: string;
        readonly senderPublicId: string;
        readonly seq: number;
        readonly messageType: MessageType;
        readonly recalledAt: Date | null;
        readonly deletedForViewer: boolean;
      }
    >
  > {
    const result = new Map<
      string,
      {
        readonly messagePublicId: string;
        readonly senderPublicId: string;
        readonly seq: number;
        readonly messageType: MessageType;
        readonly recalledAt: Date | null;
        readonly deletedForViewer: boolean;
      }
    >();

    if (params.messageIds.length === 0) {
      return result;
    }

    const uniqueIds = Array.from(new Set(params.messageIds));
    const [targetRows, deletionRows] = await Promise.all([
      executor
        .select({
          id: messages.id,
          publicId: messages.publicId,
          senderPublicId: users.publicId,
          seq: messages.seq,
          messageType: messages.messageType,
          recalledAt: messages.recalledAt,
        })
        .from(messages)
        .innerJoin(users, eq(messages.senderId, users.id))
        .where(
          and(eq(messages.conversationId, params.conversationId), inArray(messages.id, uniqueIds)),
        ),
      executor
        .select({ messageId: messageUserDeletions.messageId })
        .from(messageUserDeletions)
        .where(
          and(
            eq(messageUserDeletions.userId, params.viewerUserId),
            inArray(messageUserDeletions.messageId, uniqueIds),
          ),
        ),
    ]);

    const deletedSet = new Set(deletionRows.map((d) => d.messageId));
    for (const row of targetRows) {
      result.set(row.id, {
        messagePublicId: row.publicId,
        senderPublicId: row.senderPublicId,
        seq: Number(row.seq),
        messageType: row.messageType,
        recalledAt: row.recalledAt,
        deletedForViewer: Number(row.seq) <= params.clearedBeforeSeq || deletedSet.has(row.id),
      });
    }

    return result;
  }

  async listPinnedMessageIdsInSet(
    conversationId: string,
    messageIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Set<string>> {
    if (messageIds.length === 0) {
      return new Set();
    }
    const rows = await executor
      .select({ messageId: messagePins.messageId })
      .from(messagePins)
      .where(
        and(
          eq(messagePins.conversationId, conversationId),
          inArray(messagePins.messageId, [...messageIds]),
        ),
      );
    return new Set(rows.map((r) => r.messageId));
  }

  async listPinnedMessagesRawForConversation(
    conversationId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<
    Array<{
      readonly pin: MessagePinRow;
      readonly message: MessageRow;
      readonly senderPublicId: string;
      readonly pinnedByPublicId: string;
    }>
  > {
    const rows = await executor
      .select({
        pin: messagePins,
        message: messages,
        senderPublicId: users.publicId,
      })
      .from(messagePins)
      .innerJoin(
        messages,
        and(
          eq(messagePins.conversationId, messages.conversationId),
          eq(messagePins.messageId, messages.id),
        ),
      )
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messagePins.conversationId, conversationId))
      .orderBy(desc(messagePins.pinnedAt));

    if (rows.length === 0) {
      return [];
    }

    const pinnerIds = Array.from(new Set(rows.map((r) => r.pin.pinnedByUserId)));
    const pinnerUsers = await executor
      .select({ id: users.id, publicId: users.publicId })
      .from(users)
      .where(inArray(users.id, pinnerIds));
    const pinnerPublicIdMap = new Map(pinnerUsers.map((u) => [u.id, u.publicId]));

    return rows.map((r) => ({
      pin: r.pin,
      message: r.message,
      senderPublicId: r.senderPublicId,
      pinnedByPublicId: pinnerPublicIdMap.get(r.pin.pinnedByUserId) ?? r.senderPublicId,
    }));
  }

  async listMessageDeletionsForMessagesAndUsers(
    messageIds: readonly string[],
    userIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Array<{ readonly messageId: string; readonly userId: string }>> {
    if (messageIds.length === 0 || userIds.length === 0) {
      return [];
    }
    return executor
      .select({
        messageId: messageUserDeletions.messageId,
        userId: messageUserDeletions.userId,
      })
      .from(messageUserDeletions)
      .where(
        and(
          inArray(messageUserDeletions.messageId, [...messageIds]),
          inArray(messageUserDeletions.userId, [...userIds]),
        ),
      );
  }

  async insertMessagePin(
    params: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly pinnedByUserId: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<MessagePinRow | null> {
    const rows = await tx
      .insert(messagePins)
      .values({
        conversationId: params.conversationId,
        messageId: params.messageId,
        pinnedByUserId: params.pinnedByUserId,
        pinnedAt: params.now,
      })
      .onConflictDoNothing({
        target: [messagePins.conversationId, messagePins.messageId],
      })
      .returning();
    return rows[0] ?? null;
  }

  async deleteMessagePinsByIds(
    conversationId: string,
    messageIds: readonly string[],
    tx: DatabaseTransaction,
  ): Promise<string[]> {
    if (messageIds.length === 0) {
      return [];
    }
    const deleted = await tx
      .delete(messagePins)
      .where(
        and(
          eq(messagePins.conversationId, conversationId),
          inArray(messagePins.messageId, [...messageIds]),
        ),
      )
      .returning({ messageId: messagePins.messageId });
    return deleted.map((d) => d.messageId);
  }

  /**
   * Kiểm tra điều kiện hợp lệ để Chuyển tiếp tin nhắn (M13):
   * Chỉ cho phép nếu hai người dùng:
   * (1) Cùng theo dõi nhau (`status = 'following'` ở cả 2 chiều), HOẶC
   * (2) Đã từng có hội thoại trực tiếp ở trạng thái `primary` ở cả 2 phía.
   */
  async hasPriorPrimaryConversationBetweenUsers(
    userAId: string,
    userBId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<boolean> {
    const pairKey = buildDirectPairKey(userAId, userBId);
    const rows = await executor
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.directPairKey, pairKey),
          gt(conversations.lastSeq, 0),
          sql`EXISTS (
            SELECT 1 FROM ${conversationParticipants} cp1
            WHERE cp1.conversation_id = ${conversations.id}
              AND cp1.user_id = ${userAId}
              AND cp1.inbox_state = 'primary'
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${conversationParticipants} cp2
            WHERE cp2.conversation_id = ${conversations.id}
              AND cp2.user_id = ${userBId}
              AND cp2.inbox_state = 'primary'
          )`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Liệt kê danh sách người nhận đủ điều kiện Chuyển tiếp (M13):
   * Mutual Follow (`following` 2 chiều) ∪ Đã từng trò chuyện (`primary` 2 phía),
   * loại bỏ chính mình, tài khoản không `active` và mọi quan hệ Block 2 chiều.
   * Tìm kiếm chỉ trên `handle_normalized` / `full_name` (tuyệt đối KHÔNG tìm theo email).
   */
  async listEligibleForwardTargets(
    params: {
      readonly actorUserId: string;
      readonly query?: string;
      readonly limit: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<
    Array<{
      readonly publicId: string;
      readonly handle: string;
      readonly fullName: string;
      readonly avatarUrl: string | null;
      readonly isPrivate: boolean;
      readonly conversationPublicId: string | null;
      readonly lastMessageAt: Date | null;
    }>
  > {
    const cleanQuery = (params.query ?? '').trim().replace(/^@+/, '');
    const escapedPattern = cleanQuery
      ? `%${cleanQuery.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      : null;

    const queryFilter = escapedPattern
      ? sql`AND (
          u.handle_normalized ILIKE ${escapedPattern} ESCAPE '\\'
          OR u.full_name ILIKE ${escapedPattern} ESCAPE '\\'
        )`
      : sql``;

    const result = await executor.execute(sql`
      SELECT
        u.public_id AS "publicId",
        u.handle AS "handle",
        u.full_name AS "fullName",
        u.avatar_url AS "avatarUrl",
        u.is_private AS "isPrivate",
        conv.public_id AS "conversationPublicId",
        conv.last_message_at AS "lastMessageAt"
      FROM "users" u
      LEFT JOIN LATERAL (
        SELECT c.public_id, c.last_message_at
        FROM "conversations" c
        INNER JOIN "conversation_participants" cp_me
          ON cp_me.conversation_id = c.id
          AND cp_me.user_id = ${params.actorUserId}::uuid
          AND cp_me.inbox_state = 'primary'
        INNER JOIN "conversation_participants" cp_peer
          ON cp_peer.conversation_id = c.id
          AND cp_peer.user_id = u.id
          AND cp_peer.inbox_state = 'primary'
        WHERE c.type = 'direct'
          AND c.last_seq > 0
        LIMIT 1
      ) conv ON TRUE
      WHERE u.id <> ${params.actorUserId}::uuid
        AND u.status = 'active'
        AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "blocks" b
          WHERE (b.blocker_id = ${params.actorUserId}::uuid AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = ${params.actorUserId}::uuid)
        )
        AND (
          conv.public_id IS NOT NULL
          OR (
            EXISTS (
              SELECT 1 FROM "follows" f1
              WHERE f1.follower_id = ${params.actorUserId}::uuid
                AND f1.followee_id = u.id
                AND f1.status = 'following'
            )
            AND EXISTS (
              SELECT 1 FROM "follows" f2
              WHERE f2.follower_id = u.id
                AND f2.followee_id = ${params.actorUserId}::uuid
                AND f2.status = 'following'
            )
          )
        )
        ${queryFilter}
      ORDER BY
        CASE WHEN conv.public_id IS NOT NULL THEN 0 ELSE 1 END ASC,
        conv.last_message_at DESC NULLS LAST,
        u.full_name ASC
      LIMIT ${params.limit}
    `);

    const rows = result.rows as Array<{
      readonly publicId: string;
      readonly handle: string;
      readonly fullName: string;
      readonly avatarUrl: string | null;
      readonly isPrivate: boolean;
      readonly conversationPublicId: string | null;
      readonly lastMessageAt: Date | string | null;
    }>;

    return rows.map((r) => ({
      publicId: r.publicId,
      handle: r.handle,
      fullName: r.fullName,
      avatarUrl: r.avatarUrl,
      isPrivate: Boolean(r.isPrivate),
      conversationPublicId: r.conversationPublicId ?? null,
      lastMessageAt:
        r.lastMessageAt instanceof Date
          ? r.lastMessageAt
          : typeof r.lastMessageAt === 'string'
            ? new Date(r.lastMessageAt)
            : null,
    }));
  }
}
