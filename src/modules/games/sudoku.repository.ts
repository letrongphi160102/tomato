import 'server-only';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

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
  sudokuGames,
  sudokuRecords,
  users,
  type SudokuDifficultyValue,
  type SudokuGameRow,
  type SudokuGameStatus,
  type SudokuRecordRow,
} from '@/core/db/schema';

export interface SudokuLeaderboardRowRecord {
  readonly userId: string;
  readonly publicId: string;
  readonly handle: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly bestTimeSeconds: number;
  readonly gamesWon: number;
  readonly achievedAt: Date;
}

export class SudokuRepository {
  private readonly db: Database | undefined;

  constructor(db?: Database) {
    this.db = db;
  }

  getDefaultDb(): Database {
    return this.db ?? getDb();
  }

  async runInRlsTx<T>(
    actorUserId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return withRlsContext(actorUserId, callback, this.getDefaultDb());
  }

  async getDatabaseNow(executor: DbExecutor = this.getDefaultDb()): Promise<Date> {
    const res = await executor.execute(sql`SELECT NOW() AS now`);
    const raw = (res.rows[0] as { readonly now?: string | Date } | undefined)?.now;
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

  async abandonInProgressGamesForUser(
    userId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(sudokuGames)
      .set({
        status: 'abandoned',
        completedAt: now,
      })
      .where(and(eq(sudokuGames.userId, userId), eq(sudokuGames.status, 'in_progress')));
  }

  async insertSudokuGame(
    params: {
      readonly userId: string;
      readonly difficulty: SudokuDifficultyValue;
      readonly puzzle: string;
      readonly solution: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<SudokuGameRow> {
    const rows = await tx
      .insert(sudokuGames)
      .values({
        id: generateUuidV7(),
        publicId: generatePublicId(),
        userId: params.userId,
        difficulty: params.difficulty,
        puzzle: params.puzzle,
        solution: params.solution,
        status: 'in_progress',
        mistakesCount: 0,
        elapsedSeconds: null,
        startedAt: params.now,
        completedAt: null,
      })
      .returning();

    const created = rows[0];
    if (!created) {
      throw new Error('Không thể khởi tạo ván chơi Sudoku.');
    }
    return created;
  }

  async lockSudokuGameByPublicId(
    publicId: string,
    tx: DatabaseTransaction,
  ): Promise<SudokuGameRow | null> {
    const rows = await tx
      .select()
      .from(sudokuGames)
      .where(eq(sudokuGames.publicId, publicId))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async updateSudokuGameStatus(
    params: {
      readonly gameId: string;
      readonly status: SudokuGameStatus;
      readonly mistakesCount: number;
      readonly elapsedSeconds: number | null;
      readonly completedAt: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<SudokuGameRow | null> {
    const rows = await tx
      .update(sudokuGames)
      .set({
        status: params.status,
        mistakesCount: params.mistakesCount,
        elapsedSeconds: params.elapsedSeconds,
        completedAt: params.completedAt,
      })
      .where(eq(sudokuGames.id, params.gameId))
      .returning();
    return rows[0] ?? null;
  }

  async upsertPersonalBestRecord(
    params: {
      readonly userId: string;
      readonly difficulty: SudokuDifficultyValue;
      readonly elapsedSeconds: number;
      readonly gameId: string;
      readonly now: Date;
    },
    tx: DatabaseTransaction,
  ): Promise<{ readonly record: SudokuRecordRow; readonly previousBestSeconds: number | null }> {
    const existingRows = await tx
      .select()
      .from(sudokuRecords)
      .where(
        and(
          eq(sudokuRecords.userId, params.userId),
          eq(sudokuRecords.difficulty, params.difficulty),
        ),
      )
      .limit(1)
      .for('update');

    const previousBestSeconds = existingRows[0]?.bestTimeSeconds ?? null;

    const upsertedRows = await tx
      .insert(sudokuRecords)
      .values({
        id: generateUuidV7(),
        userId: params.userId,
        difficulty: params.difficulty,
        bestTimeSeconds: params.elapsedSeconds,
        gamesWon: 1,
        bestGameId: params.gameId,
        achievedAt: params.now,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: [sudokuRecords.userId, sudokuRecords.difficulty],
        set: {
          bestTimeSeconds: sql`LEAST(${sudokuRecords.bestTimeSeconds}, EXCLUDED.best_time_seconds)`,
          bestGameId: sql`CASE WHEN EXCLUDED.best_time_seconds < ${sudokuRecords.bestTimeSeconds} THEN EXCLUDED.best_game_id ELSE ${sudokuRecords.bestGameId} END`,
          achievedAt: sql`CASE WHEN EXCLUDED.best_time_seconds < ${sudokuRecords.bestTimeSeconds} THEN EXCLUDED.achieved_at ELSE ${sudokuRecords.achievedAt} END`,
          gamesWon: sql`${sudokuRecords.gamesWon} + 1`,
          updatedAt: params.now,
        },
      })
      .returning();

    const record = upsertedRows[0];
    if (!record) {
      throw new Error('Không thể cập nhật kỉ lục Sudoku.');
    }

    return { record, previousBestSeconds };
  }

  async listPersonalRecordsForUser(
    userId: string,
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<SudokuRecordRow[]> {
    return executor.select().from(sudokuRecords).where(eq(sudokuRecords.userId, userId));
  }

  async listLeaderboardForDifficulty(
    params: {
      readonly difficulty: SudokuDifficultyValue;
      readonly viewerUserId: string;
      readonly limit: number;
    },
    executor: DbExecutor = this.getDefaultDb(),
  ): Promise<{
    readonly topRows: SudokuLeaderboardRowRecord[];
    readonly viewerRank: number | null;
    readonly viewerRecord: SudokuRecordRow | null;
  }> {
    const visibleUserCondition = and(
      eq(sudokuRecords.difficulty, params.difficulty),
      eq(users.status, 'active'),
      isNull(users.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM ${blocks} b
        WHERE (b.blocker_id = ${params.viewerUserId} AND b.blocked_id = ${users.id})
           OR (b.blocker_id = ${users.id} AND b.blocked_id = ${params.viewerUserId})
      )`,
    );

    const topRows = await executor
      .select({
        userId: users.id,
        publicId: users.publicId,
        handle: users.handle,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        bestTimeSeconds: sudokuRecords.bestTimeSeconds,
        gamesWon: sudokuRecords.gamesWon,
        achievedAt: sudokuRecords.achievedAt,
      })
      .from(sudokuRecords)
      .innerJoin(users, eq(sudokuRecords.userId, users.id))
      .where(visibleUserCondition)
      .orderBy(
        asc(sudokuRecords.bestTimeSeconds),
        asc(sudokuRecords.achievedAt),
        asc(users.publicId),
      )
      .limit(params.limit);

    const ownRows = await executor
      .select()
      .from(sudokuRecords)
      .where(
        and(
          eq(sudokuRecords.userId, params.viewerUserId),
          eq(sudokuRecords.difficulty, params.difficulty),
        ),
      )
      .limit(1);

    const viewerRecord = ownRows[0] ?? null;
    if (!viewerRecord) {
      return {
        topRows,
        viewerRank: null,
        viewerRecord: null,
      };
    }

    const indexInTop = topRows.findIndex((row) => row.userId === params.viewerUserId);
    if (indexInTop !== -1) {
      return {
        topRows,
        viewerRank: indexInTop + 1,
        viewerRecord,
      };
    }

    const aheadCountRows = await executor
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(sudokuRecords)
      .innerJoin(users, eq(sudokuRecords.userId, users.id))
      .where(
        and(
          visibleUserCondition,
          sql`(
            ${sudokuRecords.bestTimeSeconds} < ${viewerRecord.bestTimeSeconds}
            OR (
              ${sudokuRecords.bestTimeSeconds} = ${viewerRecord.bestTimeSeconds}
              AND ${sudokuRecords.achievedAt} < ${viewerRecord.achievedAt}
            )
          )`,
        ),
      );

    const aheadCount = Number(aheadCountRows[0]?.count ?? 0);
    return {
      topRows,
      viewerRank: aheadCount + 1,
      viewerRecord,
    };
  }
}
