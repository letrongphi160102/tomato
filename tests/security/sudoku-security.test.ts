import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as completeSudokuPost } from '@/app/api/v1/games/sudoku/games/[gamePublicId]/complete/route';
import { POST as startSudokuPost } from '@/app/api/v1/games/sudoku/games/route';
import { GET as leaderboardSudokuGet } from '@/app/api/v1/games/sudoku/leaderboard/route';
import { GET as recordsSudokuGet } from '@/app/api/v1/games/sudoku/records/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import type { DatabaseTransaction } from '@/core/db';
import type {
  SessionRow,
  SudokuDifficultyValue,
  SudokuGameRow,
  SudokuRecordRow,
  UserRow,
} from '@/core/db/schema';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { solveUniqueSudoku, type GeneratedSudokuPuzzle } from '@/lib/sudoku/engine';
import {
  AuthDomainError,
  resetSessionServiceForTesting,
  setSessionServiceForTesting,
  type AuthenticatedPrincipal,
  type SessionService,
} from '@/modules/auth';
import {
  SudokuService,
  resetSudokuServiceForTesting,
  setSudokuServiceForTesting,
  type SudokuLeaderboardRowRecord,
  type SudokuRepository,
} from '@/modules/games';

const TEST_CSRF = 'ci-only-synthetic-csrf-sudoku-security';

const SAMPLE_VALID_PUZZLE =
  '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const SAMPLE_VALID_SOLUTION = solveUniqueSudoku(SAMPLE_VALID_PUZZLE)!;

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://localhost:3000';
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-11-27T02:00:00.000Z');
  return {
    id: generateUuidV7(),
    publicId: generatePublicId(),
    username: 'sudoku_user',
    handle: 'sudoku_user',
    handleNormalized: 'sudoku_user',
    fullName: 'Người Chơi Sudoku',
    bio: '',
    avatarUrl: null,
    avatarStorageKey: null,
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    followersCount: 0,
    followingCount: 0,
    handleChangedAt: null,
    gender: 'other',
    dateOfBirth: '1999-03-12',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrincipal(user: UserRow): AuthenticatedPrincipal {
  const now = new Date('2026-11-27T02:00:00.000Z');
  const session: SessionRow = {
    id: generateUuidV7(),
    publicId: generatePublicId(),
    userId: user.id,
    familyId: generatePublicId(),
    refreshTokenHash: 'ci-only-synthetic-refresh-hash',
    deviceInfo: 'Chrome',
    ipAddress: '127.0.0.1',
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    revokedAt: null,
    revokeReason: null,
    createdAt: now,
  };
  return { user, session };
}

function createAuthHeaders(
  origin: string,
  token: string | null,
  options: { includeCsrf?: boolean; contentType?: string } = {},
): Record<string, string> {
  const includeCsrf = options.includeCsrf ?? true;
  const cookies = [...(token ? [`tomato_at=${token}`] : []), `tomato_csrf=${TEST_CSRF}`];
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: cookies.join('; '),
    ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
    ...(includeCsrf ? { [CSRF_HEADER_NAME]: TEST_CSRF } : {}),
  };
}

class InMemorySudokuRepositoryMock {
  public readonly games = new Map<string, SudokuGameRow>();
  public readonly records = new Map<string, SudokuRecordRow>();
  public readonly usersById = new Map<string, UserRow>();
  public readonly blockedPairs = new Set<string>();
  public currentNow = new Date('2026-11-27T02:00:00.000Z');

  registerUser(user: UserRow): void {
    this.usersById.set(user.id, user);
  }

  addBlock(blockerId: string, blockedId: string): void {
    this.blockedPairs.add(`${blockerId}:${blockedId}`);
  }

  private isBlockedEitherWay(userA: string, userB: string): boolean {
    return this.blockedPairs.has(`${userA}:${userB}`) || this.blockedPairs.has(`${userB}:${userA}`);
  }

  async runInRlsTx<T>(
    _actorUserId: string,
    callback: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return callback({} as DatabaseTransaction);
  }

  async getDatabaseNow(): Promise<Date> {
    return this.currentNow;
  }

  async abandonInProgressGamesForUser(userId: string, now: Date): Promise<void> {
    for (const [key, game] of this.games.entries()) {
      if (game.userId === userId && game.status === 'in_progress') {
        this.games.set(key, {
          ...game,
          status: 'abandoned',
          completedAt: now,
        });
      }
    }
  }

  async insertSudokuGame(params: {
    readonly userId: string;
    readonly difficulty: SudokuDifficultyValue;
    readonly puzzle: string;
    readonly solution: string;
    readonly now: Date;
  }): Promise<SudokuGameRow> {
    const row: SudokuGameRow = {
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
    };
    this.games.set(row.id, row);
    return row;
  }

  async lockSudokuGameByPublicId(publicId: string): Promise<SudokuGameRow | null> {
    for (const row of this.games.values()) {
      if (row.publicId === publicId) {
        return row;
      }
    }
    return null;
  }

  async updateSudokuGameStatus(params: {
    readonly gameId: string;
    readonly status: SudokuGameRow['status'];
    readonly mistakesCount: number;
    readonly elapsedSeconds: number | null;
    readonly completedAt: Date;
  }): Promise<SudokuGameRow | null> {
    const existing = this.games.get(params.gameId);
    if (!existing) {
      return null;
    }
    const updated: SudokuGameRow = {
      ...existing,
      status: params.status,
      mistakesCount: params.mistakesCount,
      elapsedSeconds: params.elapsedSeconds,
      completedAt: params.completedAt,
    };
    this.games.set(params.gameId, updated);
    return updated;
  }

  async upsertPersonalBestRecord(params: {
    readonly userId: string;
    readonly difficulty: SudokuDifficultyValue;
    readonly elapsedSeconds: number;
    readonly gameId: string;
    readonly now: Date;
  }): Promise<{ readonly record: SudokuRecordRow; readonly previousBestSeconds: number | null }> {
    const key = `${params.userId}:${params.difficulty}`;
    const existing = this.records.get(key) ?? null;
    const previousBestSeconds = existing?.bestTimeSeconds ?? null;

    if (!existing) {
      const created: SudokuRecordRow = {
        id: generateUuidV7(),
        userId: params.userId,
        difficulty: params.difficulty,
        bestTimeSeconds: params.elapsedSeconds,
        gamesWon: 1,
        bestGameId: params.gameId,
        achievedAt: params.now,
        updatedAt: params.now,
      };
      this.records.set(key, created);
      return { record: created, previousBestSeconds: null };
    }

    const isFaster = params.elapsedSeconds < existing.bestTimeSeconds;
    const updated: SudokuRecordRow = {
      ...existing,
      bestTimeSeconds: isFaster ? params.elapsedSeconds : existing.bestTimeSeconds,
      bestGameId: isFaster ? params.gameId : existing.bestGameId,
      achievedAt: isFaster ? params.now : existing.achievedAt,
      gamesWon: existing.gamesWon + 1,
      updatedAt: params.now,
    };
    this.records.set(key, updated);
    return { record: updated, previousBestSeconds };
  }

  async listPersonalRecordsForUser(userId: string): Promise<SudokuRecordRow[]> {
    return Array.from(this.records.values()).filter((r) => r.userId === userId);
  }

  async listLeaderboardForDifficulty(params: {
    readonly difficulty: SudokuDifficultyValue;
    readonly viewerUserId: string;
    readonly limit: number;
  }): Promise<{
    readonly topRows: SudokuLeaderboardRowRecord[];
    readonly viewerRank: number | null;
    readonly viewerRecord: SudokuRecordRow | null;
  }> {
    const allVisible: SudokuLeaderboardRowRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.difficulty !== params.difficulty) {
        continue;
      }
      const u = this.usersById.get(rec.userId);
      if (!u || u.status !== 'active' || u.deletedAt !== null) {
        continue;
      }
      if (
        rec.userId !== params.viewerUserId &&
        this.isBlockedEitherWay(params.viewerUserId, rec.userId)
      ) {
        continue;
      }
      allVisible.push({
        userId: u.id,
        publicId: u.publicId,
        handle: u.handle,
        fullName: u.fullName,
        avatarUrl: u.avatarUrl,
        bestTimeSeconds: rec.bestTimeSeconds,
        gamesWon: rec.gamesWon,
        achievedAt: rec.achievedAt,
      });
    }

    allVisible.sort((a, b) => {
      if (a.bestTimeSeconds !== b.bestTimeSeconds) {
        return a.bestTimeSeconds - b.bestTimeSeconds;
      }
      return a.achievedAt.getTime() - b.achievedAt.getTime();
    });

    const topRows = allVisible.slice(0, params.limit);
    const viewerRecord = this.records.get(`${params.viewerUserId}:${params.difficulty}`) ?? null;
    const rankIdx = allVisible.findIndex((r) => r.userId === params.viewerUserId);
    return {
      topRows,
      viewerRank: rankIdx >= 0 ? rankIdx + 1 : null,
      viewerRecord,
    };
  }
}

describe('Sudoku Security — CSRF 3 lớp, BOLA 404 đồng nhất, Chống gian lận lời giải/đồng hồ & Ẩn Block 2 chiều', () => {
  afterEach(() => {
    resetSessionServiceForTesting();
    resetSudokuServiceForTesting();
  });

  function setupHarness() {
    const alice = makeUserRow({ username: 'alice_sdk', handle: 'alice_sdk', fullName: 'Alice' });
    const bob = makeUserRow({ username: 'bob_sdk', handle: 'bob_sdk', fullName: 'Bob' });
    const charlieBlocked = makeUserRow({
      username: 'charlie_blk',
      handle: 'charlie_blk',
      fullName: 'Charlie Blocked',
    });

    const principalsByToken = new Map<string, AuthenticatedPrincipal>([
      ['tok-alice', makePrincipal(alice)],
      ['tok-bob', makePrincipal(bob)],
      ['tok-charlie', makePrincipal(charlieBlocked)],
    ]);

    setSessionServiceForTesting({
      authenticateAccessToken: vi.fn(async (token?: string | null) => {
        const found = token ? principalsByToken.get(token) : undefined;
        if (!found) {
          throw new AuthDomainError({
            status: 401,
            code: 'UNAUTHORIZED',
            message: 'Phiên đăng nhập không hợp lệ.',
          });
        }
        return found;
      }),
    } as unknown as SessionService);

    const repo = new InMemorySudokuRepositoryMock();
    repo.registerUser(alice);
    repo.registerUser(bob);
    repo.registerUser(charlieBlocked);
    repo.addBlock(alice.id, charlieBlocked.id);

    const fixedGenerator = (difficulty: SudokuDifficultyValue): GeneratedSudokuPuzzle => ({
      difficulty,
      puzzle: SAMPLE_VALID_PUZZLE,
      solution: SAMPLE_VALID_SOLUTION,
      givensCount: 30,
      logicGrade: {
        solvedBySinglesOnly: true,
        openingNakedSingles: 5,
        hiddenSinglePlacements: 2,
        nakedPairEliminations: 0,
        stalledCellsAfterPairs: 0,
        complexityScore: 100,
      },
    });

    const service = new SudokuService({
      repository: repo as unknown as SudokuRepository,
      rateLimiter: {
        consume: vi.fn().mockResolvedValue({
          allowed: true,
          limit: 60,
          remaining: 59,
          resetAt: Date.now() + 60_000,
          retryAfterSeconds: 0,
        }),
      },
      puzzleGenerator: fixedGenerator,
      now: () => repo.currentNow,
    });
    setSudokuServiceForTesting(service);

    return { alice, bob, charlieBlocked, repo };
  }

  it('chặn 403 CSRF khi thiếu X-CSRF-Token hoặc sai Origin và chặn 401 Anon trên toàn bộ endpoint Sudoku', async () => {
    setupHarness();
    const origin = getTestOrigin();

    // Thiếu CSRF header -> 403.
    const noCsrfStart = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: false,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'easy' }),
      }),
    );
    expect(noCsrfStart.status).toBe(403);

    // Sai Origin -> 403.
    const evilOriginComplete = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${generatePublicId()}/complete`, {
        method: 'POST',
        headers: createAuthHeaders('https://evil.example', 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 45,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: generatePublicId() }) },
    );
    expect(evilOriginComplete.status).toBe(403);

    // Chưa đăng nhập (Anon) -> 401 trên cả POST và GET.
    const anonStart = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, null, {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'easy' }),
      }),
    );
    expect(anonStart.status).toBe(401);

    const anonRecords = await recordsSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/records`, {
        headers: createAuthHeaders(origin, null, { includeCsrf: false }),
      }),
    );
    expect(anonRecords.status).toBe(401);

    const anonLeaderboard = await leaderboardSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=easy`, {
        headers: createAuthHeaders(origin, null, { includeCsrf: false }),
      }),
    );
    expect(anonLeaderboard.status).toBe(401);
  });

  it('không bao giờ lộ solution hay UUIDv7 nội bộ qua API và trả 404 đồng nhất khi User B nộp bài hộ ván của User A (BOLA)', async () => {
    const { alice, repo } = setupHarness();
    const origin = getTestOrigin();

    const startRes = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'expert' }),
      }),
    );
    expect(startRes.status).toBe(201);
    const startRawText = await startRes.text();
    const startJson = JSON.parse(startRawText) as Record<string, unknown>;

    expect(startJson.puzzle).toBe(SAMPLE_VALID_PUZZLE);
    expect(startJson).not.toHaveProperty('solution');
    expect(startJson).not.toHaveProperty('id');
    expect(startRawText).not.toContain(SAMPLE_VALID_SOLUTION);
    expect(startRawText).not.toContain(alice.id);

    const gamePublicId = String(startJson.gamePublicId);
    repo.currentNow = new Date(repo.currentNow.getTime() + 60_000);

    // User B cố nộp kết quả vào `gamePublicId` của Alice -> BOLA trả 404 NOT_FOUND đồng nhất.
    const bolaRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-bob', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 60,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(bolaRes.status).toBe(404);
  });

  it('chặn gian lận thời gian quá nhanh, chặn >= 3 lỗi (409), chặn lời giải sai (400) và chặn nộp lại ván đã xong (409)', async () => {
    const { repo } = setupHarness();
    const origin = getTestOrigin();

    const startRes = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'extreme' }),
      }),
    );
    const { gamePublicId } = (await startRes.json()) as { gamePublicId: string };

    // 1. Nộp ngay sau 2 giây ở mức Cực khó (sàn vật lý 30s) -> bị chặn 400.
    repo.currentNow = new Date(repo.currentNow.getTime() + 2_000);
    const tooFastRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 120,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(tooFastRes.status).toBe(400);

    // 2. Đủ thời gian thực (45s) nhưng đã mắc đủ 3 lỗi -> bị từ chối 409 CONFLICT.
    repo.currentNow = new Date(repo.currentNow.getTime() + 45_000);
    const threeMistakesRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 3,
          elapsedSeconds: 45,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(threeMistakesRes.status).toBe(409);

    // 3. Gửi finalBoard sai lệch 2 ô -> 400 VALIDATION_ERROR.
    const wrongBoard = `91${SAMPLE_VALID_SOLUTION.slice(2)}`;
    const wrongBoardRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: wrongBoard,
          mistakesCount: 1,
          elapsedSeconds: 45,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(wrongBoardRes.status).toBe(400);

    // 4. Nộp đúng hợp lệ -> 200 OK; nộp lại lần 2 -> 409 CONFLICT.
    const okRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 2,
          elapsedSeconds: 45,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(okRes.status).toBe(200);

    const replayRes = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gamePublicId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 46,
        }),
      }),
      { params: Promise.resolve({ gamePublicId }) },
    );
    expect(replayRes.status).toBe(409);
  });

  it('ẩn 2 chiều tài khoản đã chặn (User C) trên Bảng xếp hạng nhưng vẫn cho phép Bob xem đầy đủ', async () => {
    const { alice, charlieBlocked, repo } = setupHarness();
    const origin = getTestOrigin();

    // Charlie (bị Alice chặn) giải xong mức Hard trong 40s; Alice giải xong mức Hard trong 55s.
    const charlieStart = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-charlie', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'hard' }),
      }),
    );
    const charlieGameId = ((await charlieStart.json()) as { gamePublicId: string }).gamePublicId;
    repo.currentNow = new Date(repo.currentNow.getTime() + 40_000);
    await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${charlieGameId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-charlie', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 40,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: charlieGameId }) },
    );

    const aliceStart = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ difficulty: 'hard' }),
      }),
    );
    const aliceGameId = ((await aliceStart.json()) as { gamePublicId: string }).gamePublicId;
    repo.currentNow = new Date(repo.currentNow.getTime() + 55_000);
    await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${aliceGameId}/complete`, {
        method: 'POST',
        headers: createAuthHeaders(origin, 'tok-alice', {
          includeCsrf: true,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          finalBoard: SAMPLE_VALID_SOLUTION,
          mistakesCount: 0,
          elapsedSeconds: 55,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: aliceGameId }) },
    );

    // Alice xem bảng xếp hạng Hard: Charlie bị ẩn hoàn toàn, Alice đứng #1!
    const aliceBoardRes = await leaderboardSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=hard`, {
        headers: createAuthHeaders(origin, 'tok-alice', { includeCsrf: false }),
      }),
    );
    expect(aliceBoardRes.status).toBe(200);
    const aliceBoard = (await aliceBoardRes.json()) as {
      items: Array<{ user: { public_id: string } }>;
      myRank: number | null;
    };
    expect(aliceBoard.items.map((i) => i.user.public_id)).toEqual([alice.publicId]);
    expect(aliceBoard.myRank).toBe(1);

    // Charlie xem bảng xếp hạng Hard: Alice cũng bị ẩn 2 chiều đối với Charlie!
    const charlieBoardRes = await leaderboardSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=hard`, {
        headers: createAuthHeaders(origin, 'tok-charlie', { includeCsrf: false }),
      }),
    );
    const charlieBoard = (await charlieBoardRes.json()) as {
      items: Array<{ user: { public_id: string } }>;
    };
    expect(charlieBoard.items.map((i) => i.user.public_id)).toEqual([charlieBlocked.publicId]);

    // Bob (không chặn ai) thấy đủ cả Charlie (#1 - 40s) và Alice (#2 - 55s).
    const bobBoardRes = await leaderboardSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=hard`, {
        headers: createAuthHeaders(origin, 'tok-bob', { includeCsrf: false }),
      }),
    );
    const bobBoard = (await bobBoardRes.json()) as {
      items: Array<{ rank: number; user: { public_id: string } }>;
    };
    expect(bobBoard.items.map((i) => i.user.public_id)).toEqual([
      charlieBlocked.publicId,
      alice.publicId,
    ]);
  });
});
