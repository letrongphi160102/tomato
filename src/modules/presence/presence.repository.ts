import 'server-only';

import { and, eq, inArray, or } from 'drizzle-orm';

import { getDb, type Database, type DbExecutor } from '@/core/db';
import { blocks, follows, users, type UserRow } from '@/core/db/schema';

export type PresenceUserRecord = Pick<
  UserRow,
  'id' | 'publicId' | 'status' | 'deletedAt' | 'showActiveStatus'
>;

export class PresenceRepository {
  private readonly getDefaultDb: () => Database;

  constructor(getDefaultDb: () => Database = () => getDb()) {
    this.getDefaultDb = getDefaultDb;
  }

  async findUserPresenceRecordById(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<PresenceUserRecord | null> {
    const rows = await executor
      .select({
        id: users.id,
        publicId: users.publicId,
        status: users.status,
        deletedAt: users.deletedAt,
        showActiveStatus: users.showActiveStatus,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUsersPresenceRecordsByPublicIds(
    publicIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<PresenceUserRecord[]> {
    const uniqueIds = Array.from(new Set(publicIds));
    if (uniqueIds.length === 0) {
      return [];
    }

    return executor
      .select({
        id: users.id,
        publicId: users.publicId,
        status: users.status,
        deletedAt: users.deletedAt,
        showActiveStatus: users.showActiveStatus,
      })
      .from(users)
      .where(inArray(users.publicId, uniqueIds));
  }

  async findBlockedPeerIds(
    viewerId: string,
    candidateIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Set<string>> {
    const uniqueCandidates = Array.from(new Set(candidateIds));
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
          and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, uniqueCandidates)),
          and(inArray(blocks.blockerId, uniqueCandidates), eq(blocks.blockedId, viewerId)),
        ),
      );

    const blockedSet = new Set<string>();
    for (const row of rows) {
      blockedSet.add(row.blockerId === viewerId ? row.blockedId : row.blockerId);
    }
    return blockedSet;
  }

  /**
   * Tìm tập `candidateId` có quan hệ theo dõi lẫn nhau (`following` ở cả 2 chiều) với `viewerId`.
   */
  async findMutualFollowPeerIds(
    viewerId: string,
    candidateIds: readonly string[],
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<Set<string>> {
    const uniqueCandidates = Array.from(new Set(candidateIds));
    if (uniqueCandidates.length === 0) {
      return new Set();
    }

    const rows = await executor
      .select({
        followerId: follows.followerId,
        followeeId: follows.followeeId,
      })
      .from(follows)
      .where(
        and(
          eq(follows.status, 'following'),
          or(
            and(eq(follows.followerId, viewerId), inArray(follows.followeeId, uniqueCandidates)),
            and(inArray(follows.followerId, uniqueCandidates), eq(follows.followeeId, viewerId)),
          ),
        ),
      );

    const viewerFollows = new Set<string>();
    const followsViewer = new Set<string>();
    for (const row of rows) {
      if (row.followerId === viewerId) {
        viewerFollows.add(row.followeeId);
      } else if (row.followeeId === viewerId) {
        followsViewer.add(row.followerId);
      }
    }

    const mutual = new Set<string>();
    for (const peerId of viewerFollows) {
      if (followsViewer.has(peerId)) {
        mutual.add(peerId);
      }
    }
    return mutual;
  }

  /**
   * Điểm mở rộng sẵn sàng cho M9 (Nhắn tin 1-1): trả tập người dùng có hội thoại ở Hộp thư chính (`primary`).
   * Ở M8 bảng `conversations` chưa tồn tại nên mặc định trả tập rỗng.
   */
  async findPrimaryConversationPeerIds(
    viewerId: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    void viewerId;
    void candidateIds;
    return new Set();
  }
}
