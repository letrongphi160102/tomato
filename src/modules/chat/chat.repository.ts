import 'server-only';

import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import {
  getDb,
  withRlsContext,
  type Database,
  type DatabaseTransaction,
  type DbExecutor,
} from '@/core/db';
import {
  blocks,
  conversationParticipants,
  conversations,
  follows,
  messageUserDeletions,
  messages,
  userE2eeDevices,
  userE2eeKeyBackups,
  users,
  type ConversationInboxState,
  type ConversationParticipantRow,
  type ConversationRow,
  type E2eeBackupKdfParamsRecord,
  type E2eePublicJwkRecord,
  type MessageCryptoHeaderRecord,
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

  // =========================================================================
  // E2EE Device Keys & PIN Backups
  // =========================================================================

  async listActiveDevicesForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<UserE2eeDeviceRow[]> {
    return executor
      .select()
      .from(userE2eeDevices)
      .where(and(eq(userE2eeDevices.userId, userId), isNull(userE2eeDevices.revokedAt)))
      .orderBy(desc(userE2eeDevices.createdAt), asc(userE2eeDevices.id));
  }

  async upsertUserE2eeDevice(
    params: {
      readonly userId: string;
      readonly sessionFamilyId: string | null;
      readonly deviceLabel: string;
      readonly identityPublicKeyJwk: E2eePublicJwkRecord;
      readonly signingPublicKeyJwk: E2eePublicJwkRecord;
      readonly keyFingerprint: string;
      readonly maxActiveDevices: number;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<{
    readonly device: UserE2eeDeviceRow;
    readonly revokedDevicePublicIds: readonly string[];
  }> {
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
          revokedAt: null,
          lastSeenAt: params.now,
        },
      })
      .returning();

    const currentDevice = upsertedRows[0]!;

    // Kiểm tra tổng số thiết bị đang hoạt động của user; nếu vượt quá `maxActiveDevices` (10),
    // tự động thu hồi các thiết bị cũ nhất (ưu tiên giữ lại khóa sao lưu PIN nếu có).
    const activeDevices = await tx
      .select()
      .from(userE2eeDevices)
      .where(and(eq(userE2eeDevices.userId, params.userId), isNull(userE2eeDevices.revokedAt)))
      .orderBy(desc(userE2eeDevices.lastSeenAt), desc(userE2eeDevices.createdAt));

    const revokedDevicePublicIds: string[] = [];
    if (activeDevices.length > params.maxActiveDevices) {
      const backupRow = await this.findKeyBackupByUserId(params.userId, tx);
      const backupFingerprint = backupRow?.keyFingerprint ?? null;

      const removable = activeDevices.filter(
        (d) => d.id !== currentDevice.id && d.keyFingerprint !== backupFingerprint,
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
        'inboxState' | 'pendingMessagesSent' | 'lastReadSeq' | 'clearedBeforeSeq' | 'hiddenAt'
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

    const results: ConversationListRowRecord[] = [];
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

      let lastMessage: ConversationListRowRecord['lastMessage'] = null;
      if (item.conversation.lastSeq > item.participant.clearedBeforeSeq) {
        lastMessage = await this.findLatestVisibleMessageForConversation(
          {
            conversationId: item.conversation.id,
            viewerUserId: params.userId,
            clearedBeforeSeq: Number(item.participant.clearedBeforeSeq),
          },
          executor,
        );
      }

      results.push({
        conversation: item.conversation,
        actorParticipant: item.participant,
        peerParticipant: peerInfo.participant,
        peerUser: peerInfo.user,
        lastMessage,
      });
    }

    return results;
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
        attachmentStorageKey: null,
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
}
