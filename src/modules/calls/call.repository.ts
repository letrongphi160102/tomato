import 'server-only';

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

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
  callSessions,
  conversationParticipants,
  conversations,
  follows,
  messages,
  users,
  type CallSessionRow,
  type CallStatus,
  type CallType,
  type ConversationParticipantRow,
  type ConversationRow,
  type MessageCallEventMetaRecord,
  type MessageRow,
  type UserRow,
} from '@/core/db/schema';
import { CALL_HEARTBEAT_STALE_MS, CALL_RING_TIMEOUT_MS } from '@/modules/calls/call.schemas';
import type { SocialRelationshipSnapshot } from '@/modules/social/social.policy';

export type CallUserRecord = Pick<
  UserRow,
  'id' | 'publicId' | 'handle' | 'fullName' | 'avatarUrl' | 'status' | 'deletedAt'
>;

export interface SweptStaleCallRecord {
  readonly session: CallSessionRow;
  readonly previousStatus: 'ringing' | 'connected';
  readonly nextStatus: 'missed' | 'ended';
  readonly conversationPublicId: string;
  readonly callerPublicId: string;
  readonly calleePublicId: string;
}

export interface TerminatedBlockCallRecord {
  readonly callPublicId: string;
  readonly conversationPublicId: string;
  readonly endedAt: Date;
}

const CALL_USER_COLUMNS = {
  id: users.id,
  publicId: users.publicId,
  handle: users.handle,
  fullName: users.fullName,
  avatarUrl: users.avatarUrl,
  status: users.status,
  deletedAt: users.deletedAt,
};

export class CallRepository {
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

  async getDatabaseNow(executor: DbExecutor = this.getDefaultDb()): Promise<Date> {
    const result = await executor.execute(sql`SELECT NOW() AS now`);
    const first = (result.rows as Array<{ readonly now?: Date | string }>)[0];
    if (first?.now instanceof Date) {
      return first.now;
    }
    if (typeof first?.now === 'string') {
      const parsed = new Date(first.now);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return new Date();
  }

  async findUserById(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<CallUserRecord | null> {
    const rows = await executor
      .select(CALL_USER_COLUMNS)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Khóa danh sách `users` theo thứ tự chuẩn `id ASC FOR UPDATE`
   * để đồng bộ thứ tự khóa toàn cục với `SocialService` và chống deadlock.
   */
  async lockUsersInCanonicalOrder(
    userIds: readonly string[],
    tx: DatabaseTransaction,
  ): Promise<Map<string, CallUserRecord>> {
    const uniqueSorted = Array.from(new Set(userIds)).sort();
    if (uniqueSorted.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select(CALL_USER_COLUMNS)
      .from(users)
      .where(inArray(users.id, uniqueSorted))
      .orderBy(asc(users.id))
      .for('update');
    return new Map(rows.map((row) => [row.id, row]));
  }

  async getRelationshipSnapshot(
    actorUserId: string,
    targetUserId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SocialRelationshipSnapshot> {
    if (actorUserId === targetUserId) {
      return {
        blockedByActor: false,
        blockedByTarget: false,
        actorFollowStatus: 'none',
        targetFollowStatus: 'none',
      };
    }

    const [followRows, blockRows] = await Promise.all([
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
    ]);

    let actorFollowStatus: SocialRelationshipSnapshot['actorFollowStatus'] = 'none';
    let targetFollowStatus: SocialRelationshipSnapshot['targetFollowStatus'] = 'none';
    for (const row of followRows) {
      if (row.followerId === actorUserId && row.followeeId === targetUserId) {
        actorFollowStatus = row.status;
      } else if (row.followerId === targetUserId && row.followeeId === actorUserId) {
        targetFollowStatus = row.status;
      }
    }

    let blockedByActor = false;
    let blockedByTarget = false;
    for (const row of blockRows) {
      if (row.blockerId === actorUserId && row.blockedId === targetUserId) {
        blockedByActor = true;
      } else if (row.blockerId === targetUserId && row.blockedId === actorUserId) {
        blockedByTarget = true;
      }
    }

    return {
      blockedByActor,
      blockedByTarget,
      actorFollowStatus,
      targetFollowStatus,
    };
  }

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

  async listConversationParticipants(
    conversationId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<ConversationParticipantRow[]> {
    return executor
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(conversationParticipants.userId));
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

  async findCallSessionByPublicId(
    publicId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<CallSessionRow | null> {
    const rows = await executor
      .select()
      .from(callSessions)
      .where(eq(callSessions.publicId, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  async lockCallSessionByPublicId(
    publicId: string,
    tx: DatabaseTransaction,
  ): Promise<CallSessionRow | null> {
    const rows = await tx
      .select()
      .from(callSessions)
      .where(eq(callSessions.publicId, publicId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Tự động quét (auto-sweep) các phiên cuộc gọi quá hạn mà `actorUserId` là thành viên (tuân thủ RLS):
   * - `ringing` quá 45 giây -> chuyển thành `'missed'`
   * - `connected` mất heartbeat quá 2 phút (120 giây) -> chuyển thành `'ended'`
   */
  async sweepStaleCallsVisibleToActor(
    actorUserId: string,
    serverNow: Date,
    tx: DatabaseTransaction,
  ): Promise<SweptStaleCallRecord[]> {
    const ringCutoff = new Date(serverNow.getTime() - CALL_RING_TIMEOUT_MS);
    const heartbeatCutoff = new Date(serverNow.getTime() - CALL_HEARTBEAT_STALE_MS);

    const activeRows = await tx
      .select()
      .from(callSessions)
      .where(
        and(
          or(eq(callSessions.callerId, actorUserId), eq(callSessions.calleeId, actorUserId)),
          inArray(callSessions.status, ['ringing', 'connected']),
        ),
      )
      .orderBy(asc(callSessions.id))
      .for('update');

    const swept: SweptStaleCallRecord[] = [];

    for (const row of activeRows) {
      let nextStatus: 'missed' | 'ended' | null = null;
      if (row.status === 'ringing' && row.startedAt.getTime() <= ringCutoff.getTime()) {
        nextStatus = 'missed';
      } else if (row.status === 'connected') {
        const lastBeat = row.lastHeartbeatAt ?? row.connectedAt ?? row.startedAt;
        if (lastBeat.getTime() <= heartbeatCutoff.getTime()) {
          nextStatus = 'ended';
        }
      }

      if (!nextStatus) {
        continue;
      }

      const updatedRows = await tx
        .update(callSessions)
        .set({
          status: nextStatus,
          endedAt: serverNow,
        })
        .where(eq(callSessions.id, row.id))
        .returning();

      const updated = updatedRows[0];
      if (!updated) {
        continue;
      }

      const [conv, caller, callee] = await Promise.all([
        this.findConversationById(updated.conversationId, tx),
        this.findUserById(updated.callerId, tx),
        this.findUserById(updated.calleeId, tx),
      ]);

      if (conv && caller && callee) {
        swept.push({
          session: updated,
          previousStatus: row.status as 'ringing' | 'connected',
          nextStatus,
          conversationPublicId: conv.publicId,
          callerPublicId: caller.publicId,
          calleePublicId: callee.publicId,
        });
      }
    }

    return swept;
  }

  /**
   * Gọi hàm DB `SECURITY DEFINER` chỉ dọn các phiên `ringing > 45s` / `connected > 120s` đã hết hạn
   * cho người dùng đích (không trả dữ liệu hay số lượng để đảm bảo 0% rò rỉ thông tin qua RLS).
   */
  async sweepStaleCallsForTargetViaDbFunction(
    targetUserId: string,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx.execute(sql`SELECT "public"."app_sweep_stale_calls_for_user"(${targetUserId}::uuid)`);
  }

  /**
   * Gọi hàm DB `SECURITY DEFINER` kiểm tra xem `targetUserId` có cuộc gọi đang thực sự hoạt động không
   * (tự động loại trừ phiên `ringing > 45s` và `connected` mất heartbeat `> 120s`).
   */
  async hasActiveCallViaDbFunction(
    targetUserId: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const result = await tx.execute(
      sql`SELECT "public"."app_user_has_active_call"(${targetUserId}::uuid) AS active`,
    );
    const first = (result.rows as Array<{ readonly active?: boolean }>)[0];
    return Boolean(first?.active);
  }

  async insertCallSession(
    params: {
      readonly conversationId: string;
      readonly callerId: string;
      readonly calleeId: string;
      readonly callType: CallType;
      readonly status: CallStatus;
      readonly startedAt: Date;
      readonly connectedAt?: Date | null;
      readonly lastHeartbeatAt: Date;
      readonly endedAt?: Date | null;
    },
    tx: DatabaseTransaction,
  ): Promise<CallSessionRow> {
    const rows = await tx
      .insert(callSessions)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        conversationId: params.conversationId,
        callerId: params.callerId,
        calleeId: params.calleeId,
        callType: params.callType,
        status: params.status,
        startedAt: params.startedAt,
        connectedAt: params.connectedAt ?? null,
        lastHeartbeatAt: params.lastHeartbeatAt,
        endedAt: params.endedAt ?? null,
      })
      .returning();

    return rows[0]!;
  }

  async updateCallSession(
    callId: string,
    patch: Partial<Pick<CallSessionRow, 'status' | 'connectedAt' | 'lastHeartbeatAt' | 'endedAt'>>,
    tx: DatabaseTransaction,
  ): Promise<CallSessionRow | null> {
    const rows = await tx
      .update(callSessions)
      .set(patch)
      .where(eq(callSessions.id, callId))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Kết thúc tức thì mọi phiên cuộc gọi đang `ringing` hoặc `connected` giữa 2 người dùng khi xảy ra Block.
   * Caller phải đã thiết lập `applyRlsSessionContext(tx, blockerId)` trước khi gọi hàm này.
   */
  async terminateActiveCallsBetweenUsersInTx(
    userAId: string,
    userBId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<TerminatedBlockCallRecord[]> {
    const activeRows = await tx
      .select()
      .from(callSessions)
      .where(
        and(
          or(
            and(eq(callSessions.callerId, userAId), eq(callSessions.calleeId, userBId)),
            and(eq(callSessions.callerId, userBId), eq(callSessions.calleeId, userAId)),
          ),
          inArray(callSessions.status, ['ringing', 'connected']),
        ),
      )
      .orderBy(asc(callSessions.id))
      .for('update');

    if (activeRows.length === 0) {
      return [];
    }

    const terminated: TerminatedBlockCallRecord[] = [];
    for (const row of activeRows) {
      await tx
        .update(callSessions)
        .set({
          status: 'ended',
          endedAt: now,
        })
        .where(eq(callSessions.id, row.id));

      const conv = await this.findConversationById(row.conversationId, tx);
      if (conv) {
        terminated.push({
          callPublicId: row.publicId,
          conversationPublicId: conv.publicId,
          endedAt: now,
        });
      }
    }

    return terminated;
  }

  /**
   * Ghi thẻ lịch sử cuộc gọi (`message_type = 'call_event'`, `ciphertext = NULL`, `crypto_header = NULL`)
   * vào bảng `messages` một cách nguyên tử & idempotent theo `client_msg_id = 'call_event:' + callPublicId`.
   * Giữ nguyên bất biến RLS: `sender_id = actorUserId` (khớp `app_current_user_id()`).
   */
  async insertCallEventMessageInTx(
    params: {
      readonly conversationId: string;
      readonly actorUserId: string;
      readonly callerUserId: string;
      readonly calleeUserId: string;
      readonly callEventMeta: MessageCallEventMetaRecord;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<{ readonly message: MessageRow; readonly created: boolean } | null> {
    const lockedConv = await this.lockConversationById(params.conversationId, tx);
    if (!lockedConv) {
      return null;
    }

    const clientMsgId = `call_event:${params.callEventMeta.callPublicId}`;
    const existingRows = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, lockedConv.id), eq(messages.clientMsgId, clientMsgId)))
      .limit(1);

    if (existingRows[0]) {
      return { message: existingRows[0], created: false };
    }

    const nextSeq = Number(lockedConv.lastSeq) + 1;

    await tx
      .update(conversations)
      .set({
        lastSeq: nextSeq,
        lastMessageAt: params.now,
      })
      .where(eq(conversations.id, lockedConv.id));

    const insertedRows = await tx
      .insert(messages)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        conversationId: lockedConv.id,
        senderId: params.actorUserId,
        seq: nextSeq,
        clientMsgId,
        messageType: 'call_event',
        ciphertext: null,
        cryptoHeader: null,
        callEventMeta: params.callEventMeta,
        attachmentStorageKey: null,
        editCount: 0,
        editedAt: null,
        recalledAt: null,
        createdAt: params.now,
      })
      .returning();

    const insertedMsg = insertedRows[0]!;

    // Gỡ ẩn (`hidden_at = NULL`) nếu người dùng trong hội thoại `primary` từng xóa cuộc trò chuyện trước đó.
    const participants = await this.lockConversationParticipants(lockedConv.id, tx);
    for (const part of participants) {
      const shouldAdvanceRead =
        params.callEventMeta.status === 'ended' ||
        (params.callEventMeta.status === 'declined' && part.userId === params.actorUserId) ||
        ((params.callEventMeta.status === 'missed' || params.callEventMeta.status === 'busy') &&
          part.userId === params.callerUserId);

      const patch: Partial<Pick<ConversationParticipantRow, 'lastReadSeq' | 'hiddenAt'>> = {};
      if (shouldAdvanceRead && Number(part.lastReadSeq) < nextSeq) {
        patch.lastReadSeq = nextSeq;
      }
      if (part.inboxState === 'primary' && part.hiddenAt !== null) {
        patch.hiddenAt = null;
      }

      if (Object.keys(patch).length > 0) {
        await tx
          .update(conversationParticipants)
          .set(patch)
          .where(
            and(
              eq(conversationParticipants.conversationId, lockedConv.id),
              eq(conversationParticipants.userId, part.userId),
            ),
          );
      }
    }

    return { message: insertedMsg, created: true };
  }
}
