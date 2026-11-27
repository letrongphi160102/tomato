import 'server-only';

import { GAME_RATE_LIMITS, getRateLimiter, type RateLimiter } from '@/core/redis';
import { formatZodErrorDetails } from '@/core/security/http-response';
import {
  MAX_SUDOKU_MISTAKES,
  SUDOKU_DIFFICULTIES,
  SUDOKU_DIFFICULTY_META,
  generateUniqueSudoku,
  isValidSolvedSudokuGrid,
  type GeneratedSudokuPuzzle,
  type SudokuDifficulty,
} from '@/lib/sudoku/engine';
import type { AuthenticatedPrincipal } from '@/modules/auth/auth.policy';
import { SudokuDomainError } from '@/modules/games/sudoku.errors';
import { SUDOKU_MESSAGES } from '@/modules/games/sudoku.messages';
import { assertSudokuAuthorized } from '@/modules/games/sudoku.policy';
import { SudokuRepository } from '@/modules/games/sudoku.repository';
import {
  completeSudokuGameInputSchema,
  startSudokuGameInputSchema,
  sudokuGamePublicIdParamSchema,
  sudokuLeaderboardQuerySchema,
} from '@/modules/games/sudoku.schemas';

export interface SudokuPersonalDifficultyRecordDto {
  readonly difficulty: SudokuDifficulty;
  readonly bestTimeSeconds: number | null;
  readonly gamesWon: number;
  readonly achievedAt: string | null;
}

export interface SudokuLeaderboardEntryDto {
  readonly rank: number;
  readonly user: {
    readonly public_id: string;
    readonly handle: string;
    readonly fullName: string;
    readonly avatarUrl: string | null;
    readonly isCurrentUser: boolean;
  };
  readonly bestTimeSeconds: number;
  readonly gamesWon: number;
  readonly achievedAt: string;
}

export interface StartSudokuGameResult {
  readonly gamePublicId: string;
  readonly difficulty: SudokuDifficulty;
  readonly puzzle: string;
  readonly maxMistakes: number;
  readonly startedAt: string;
}

export interface CompleteSudokuGameResult {
  readonly gamePublicId: string;
  readonly difficulty: SudokuDifficulty;
  readonly elapsedSeconds: number;
  readonly isNewPersonalBest: boolean;
  readonly personalBestSeconds: number;
  readonly gamesWon: number;
  readonly rank: number | null;
  readonly message: string;
}

export interface SudokuPersonalRecordsResult {
  readonly records: Readonly<Record<SudokuDifficulty, SudokuPersonalDifficultyRecordDto>>;
}

export interface SudokuLeaderboardResult {
  readonly difficulty: SudokuDifficulty;
  readonly items: readonly SudokuLeaderboardEntryDto[];
  readonly myRank: number | null;
  readonly myBestTimeSeconds: number | null;
  readonly myGamesWon: number;
}

export interface SudokuServiceOptions {
  readonly repository?: SudokuRepository;
  readonly rateLimiter?: Pick<RateLimiter, 'consume'>;
  readonly puzzleGenerator?: (difficulty: SudokuDifficulty) => GeneratedSudokuPuzzle;
  readonly now?: () => Date;
  readonly enforceHumanTimeFloor?: boolean;
}

export class SudokuService {
  private readonly repository: SudokuRepository;
  private readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  private readonly puzzleGenerator: (difficulty: SudokuDifficulty) => GeneratedSudokuPuzzle;
  private readonly now: () => Date;
  private readonly hasCustomNow: boolean;
  private readonly enforceHumanTimeFloor: boolean;

  constructor(options: SudokuServiceOptions = {}) {
    this.repository = options.repository ?? new SudokuRepository();
    this.rateLimiter = options.rateLimiter ?? getRateLimiter();
    this.puzzleGenerator = options.puzzleGenerator ?? ((diff) => generateUniqueSudoku(diff));
    this.hasCustomNow = typeof options.now === 'function';
    this.now = options.now ?? (() => new Date());
    this.enforceHumanTimeFloor = options.enforceHumanTimeFloor ?? true;
  }

  private async consumeRateLimitOrThrow(
    key: string,
    rule: (typeof GAME_RATE_LIMITS)[keyof typeof GAME_RATE_LIMITS],
  ): Promise<void> {
    const result = await this.rateLimiter.consume(key, rule);
    if (!result.allowed) {
      throw new SudokuDomainError({
        status: 429,
        code: 'RATE_LIMITED',
        message: SUDOKU_MESSAGES.rateLimited(result.retryAfterSeconds),
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  private parseGamePublicIdOrThrowNotFound(rawGamePublicId: string): string {
    const parsed = sudokuGamePublicIdParamSchema.safeParse(rawGamePublicId);
    if (!parsed.success) {
      throw new SudokuDomainError({
        status: 404,
        code: 'NOT_FOUND',
        message: SUDOKU_MESSAGES.notFound,
      });
    }
    return parsed.data;
  }

  async startNewGame(
    actor: AuthenticatedPrincipal,
    rawInput: unknown,
  ): Promise<StartSudokuGameResult> {
    assertSudokuAuthorized(actor, 'sudoku:game:start');
    await this.consumeRateLimitOrThrow(
      `games:sudoku:start:user:${actor.user.id}`,
      GAME_RATE_LIMITS.startSudokuByUser,
    );

    const parsed = startSudokuGameInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new SudokuDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SUDOKU_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    // Sinh bảng Sudoku nghiệm duy nhất ở ngoài DB transaction để không giữ kết nối pool.
    const generated = this.puzzleGenerator(parsed.data.difficulty);

    const created = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const serverNow = this.hasCustomNow ? this.now() : await this.repository.getDatabaseNow(tx);
      await this.repository.abandonInProgressGamesForUser(actor.user.id, serverNow, tx);
      return this.repository.insertSudokuGame(
        {
          userId: actor.user.id,
          difficulty: generated.difficulty,
          puzzle: generated.puzzle,
          solution: generated.solution,
          now: serverNow,
        },
        tx,
      );
    });

    // Chỉ trả `puzzle` (81 ký tự có '0'), tuyệt đối KHÔNG gửi `solution` qua HTTP response.
    return {
      gamePublicId: created.publicId,
      difficulty: created.difficulty,
      puzzle: created.puzzle,
      maxMistakes: MAX_SUDOKU_MISTAKES,
      startedAt: created.startedAt.toISOString(),
    };
  }

  async completeGame(
    actor: AuthenticatedPrincipal,
    rawGamePublicId: string,
    rawInput: unknown,
  ): Promise<CompleteSudokuGameResult> {
    assertSudokuAuthorized(actor, 'sudoku:game:start');
    await this.consumeRateLimitOrThrow(
      `games:sudoku:complete:user:${actor.user.id}`,
      GAME_RATE_LIMITS.completeSudokuByUser,
    );

    const gamePublicId = this.parseGamePublicIdOrThrowNotFound(rawGamePublicId);
    const parsed = completeSudokuGameInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new SudokuDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SUDOKU_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    if (parsed.data.mistakesCount >= MAX_SUDOKU_MISTAKES) {
      throw new SudokuDomainError({
        status: 409,
        code: 'CONFLICT',
        message: SUDOKU_MESSAGES.tooManyMistakes,
      });
    }

    return this.repository.runInRlsTx(actor.user.id, async (tx) => {
      const lockedGame = await this.repository.lockSudokuGameByPublicId(gamePublicId, tx);
      assertSudokuAuthorized(actor, 'sudoku:game:complete', { game: lockedGame });

      if (lockedGame!.status !== 'in_progress') {
        throw new SudokuDomainError({
          status: 409,
          code: 'CONFLICT',
          message: SUDOKU_MESSAGES.alreadyFinished,
        });
      }

      if (
        parsed.data.finalBoard !== lockedGame!.solution ||
        !isValidSolvedSudokuGrid(parsed.data.finalBoard)
      ) {
        throw new SudokuDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: SUDOKU_MESSAGES.invalidBoardSolution,
        });
      }

      const serverNow = this.hasCustomNow ? this.now() : await this.repository.getDatabaseNow(tx);
      const wallClockElapsedSeconds = Math.max(
        1,
        Math.ceil((serverNow.getTime() - lockedGame!.startedAt.getTime()) / 1000),
      );

      // Chống gian lận đồng hồ:
      // 1. Không chấp nhận thời gian nhỏ hơn sàn tốc độ vật lý tối thiểu theo độ khó.
      // 2. Nếu client gửi elapsedSeconds lớn hơn thời gian thực kể từ lúc phát đề (+2s dung sai làm tròn), kẹp về wallClock;
      //    nếu người chơi có Tạm dừng hợp lệ (clientElapsed <= wallClock), chấp nhận clientElapsed miễn là cả clientElapsed và wallClock đều đạt sàn tối thiểu!
      const minFloor = this.enforceHumanTimeFloor
        ? SUDOKU_DIFFICULTY_META[lockedGame!.difficulty].minHumanSolveSeconds
        : 1;

      if (wallClockElapsedSeconds < minFloor || parsed.data.elapsedSeconds < minFloor) {
        throw new SudokuDomainError({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: SUDOKU_MESSAGES.invalidElapsedTime,
        });
      }

      const verifiedElapsedSeconds = Math.min(
        parsed.data.elapsedSeconds,
        wallClockElapsedSeconds + 2,
      );

      await this.repository.updateSudokuGameStatus(
        {
          gameId: lockedGame!.id,
          status: 'completed',
          mistakesCount: parsed.data.mistakesCount,
          elapsedSeconds: verifiedElapsedSeconds,
          completedAt: serverNow,
        },
        tx,
      );

      const { record, previousBestSeconds } = await this.repository.upsertPersonalBestRecord(
        {
          userId: actor.user.id,
          difficulty: lockedGame!.difficulty,
          elapsedSeconds: verifiedElapsedSeconds,
          gameId: lockedGame!.id,
          now: serverNow,
        },
        tx,
      );

      const leaderboardSnapshot = await this.repository.listLeaderboardForDifficulty(
        {
          difficulty: lockedGame!.difficulty,
          viewerUserId: actor.user.id,
          limit: 50,
        },
        tx,
      );

      const isNewPersonalBest =
        previousBestSeconds === null || verifiedElapsedSeconds < previousBestSeconds;

      return {
        gamePublicId: lockedGame!.publicId,
        difficulty: lockedGame!.difficulty,
        elapsedSeconds: verifiedElapsedSeconds,
        isNewPersonalBest,
        personalBestSeconds: record.bestTimeSeconds,
        gamesWon: record.gamesWon,
        rank: leaderboardSnapshot.viewerRank,
        message: SUDOKU_MESSAGES.gameCompleted,
      };
    });
  }

  async getPersonalRecords(actor: AuthenticatedPrincipal): Promise<SudokuPersonalRecordsResult> {
    assertSudokuAuthorized(actor, 'sudoku:records:read');
    await this.consumeRateLimitOrThrow(
      `games:sudoku:records:user:${actor.user.id}`,
      GAME_RATE_LIMITS.readSudokuRecordsByUser,
    );

    const rows = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.listPersonalRecordsForUser(actor.user.id, tx);
    });

    const byDiff = new Map(rows.map((r) => [r.difficulty, r]));
    const records = {} as Record<SudokuDifficulty, SudokuPersonalDifficultyRecordDto>;

    for (const diff of SUDOKU_DIFFICULTIES) {
      const found = byDiff.get(diff);
      records[diff] = {
        difficulty: diff,
        bestTimeSeconds: found?.bestTimeSeconds ?? null,
        gamesWon: found?.gamesWon ?? 0,
        achievedAt: found ? found.achievedAt.toISOString() : null,
      };
    }

    return { records };
  }

  async getLeaderboard(
    actor: AuthenticatedPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<SudokuLeaderboardResult> {
    assertSudokuAuthorized(actor, 'sudoku:leaderboard:read');
    await this.consumeRateLimitOrThrow(
      `games:sudoku:records:user:${actor.user.id}`,
      GAME_RATE_LIMITS.readSudokuRecordsByUser,
    );

    const parsed = sudokuLeaderboardQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new SudokuDomainError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: SUDOKU_MESSAGES.validationFailed,
        details: formatZodErrorDetails(parsed.error),
      });
    }

    const data = await this.repository.runInRlsTx(actor.user.id, async (tx) => {
      return this.repository.listLeaderboardForDifficulty(
        {
          difficulty: parsed.data.difficulty,
          viewerUserId: actor.user.id,
          limit: parsed.data.limit,
        },
        tx,
      );
    });

    return {
      difficulty: parsed.data.difficulty,
      items: data.topRows.map((row, index) => ({
        rank: index + 1,
        user: {
          public_id: row.publicId,
          handle: row.handle,
          fullName: row.fullName,
          avatarUrl: row.avatarUrl,
          isCurrentUser: row.userId === actor.user.id,
        },
        bestTimeSeconds: row.bestTimeSeconds,
        gamesWon: row.gamesWon,
        achievedAt: row.achievedAt.toISOString(),
      })),
      myRank: data.viewerRank,
      myBestTimeSeconds: data.viewerRecord?.bestTimeSeconds ?? null,
      myGamesWon: data.viewerRecord?.gamesWon ?? 0,
    };
  }
}
