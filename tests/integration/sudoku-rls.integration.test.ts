import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginPost } from '@/app/api/v1/auth/login/route';
import { POST as completeSudokuPost } from '@/app/api/v1/games/sudoku/games/[gamePublicId]/complete/route';
import { POST as startSudokuPost } from '@/app/api/v1/games/sudoku/games/route';
import { GET as leaderboardSudokuGet } from '@/app/api/v1/games/sudoku/leaderboard/route';
import { GET as recordsSudokuGet } from '@/app/api/v1/games/sudoku/records/route';
import { POST as blockPost } from '@/app/api/v1/social/blocks/[userPublicId]/route';
import { getEnv } from '@/core/config/env';
import { generatePublicId, generateUuidV7 } from '@/core/crypto/id';
import { hashPassword } from '@/core/crypto/password';
import { closeDatabasePool, getDb } from '@/core/db';
import { authIdentities, sudokuGames, users } from '@/core/db/schema';
import type { EmailMessage, EmailProvider } from '@/core/email';
import {
  InMemoryRealtimeAdapter,
  resetRealtimeProviderForTesting,
  setRealtimeProviderForTesting,
} from '@/core/realtime';
import { LoginBruteForceGuard, RateLimiter, closeRedisClient, getRedisClient } from '@/core/redis';
import { AuditLogService } from '@/core/security/audit-log.service';
import { CSRF_HEADER_NAME } from '@/core/security/csrf';
import { solveUniqueSudoku } from '@/lib/sudoku/engine';
import {
  AuthRepository,
  AuthService,
  SessionService,
  resetAuthServiceForTesting,
  resetSessionServiceForTesting,
  setAuthServiceForTesting,
  setSessionServiceForTesting,
} from '@/modules/auth';
import {
  SudokuRepository,
  SudokuService,
  resetSudokuServiceForTesting,
  setSudokuServiceForTesting,
} from '@/modules/games';
import {
  NotificationRepository,
  NotificationService,
  resetNotificationServiceForTesting,
  setNotificationServiceForTesting,
} from '@/modules/notifications';
import {
  PresenceRepository,
  PresenceService,
  resetPresenceServiceForTesting,
  setPresenceServiceForTesting,
} from '@/modules/presence';
import {
  SocialRepository,
  SocialService,
  resetSocialServiceForTesting,
  setSocialServiceForTesting,
} from '@/modules/social';

const TEST_PASSWORD = 'ci-only-synthetic-Pass#2026';

function getTestOrigin(): string {
  return getEnv().ALLOWED_ORIGINS[0] ?? 'http://127.0.0.1:3000';
}

let ipCounter = 30;
function nextTestIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 180) + 20}`;
}

function makeUniqueTag(prefix: string): string {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
}

class SilentEmailProvider implements EmailProvider {
  public readonly provider = 'memory' as const;
  public readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface CookieJar {
  at?: string;
  rt?: string;
  csrf?: string;
}

function extractCookies(response: Response, previous: CookieJar = {}): CookieJar {
  const next: CookieJar = { ...previous };
  for (const header of response.headers.getSetCookie()) {
    const first = header.split(';')[0] ?? '';
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();
    const isCleared = /Max-Age=0/i.test(header) || value === '';

    if (name === 'tomato_at' || name === '__Host-tomato_at') {
      next.at = isCleared ? undefined : value;
    } else if (name === 'tomato_rt' || name === '__Host-tomato_rt') {
      next.rt = isCleared ? undefined : value;
    } else if (name === 'tomato_csrf' || name === '__Host-tomato_csrf') {
      next.csrf = isCleared ? undefined : value;
    }
  }
  return next;
}

function createHeaders(
  jar: CookieJar,
  ip: string,
  options: { includeCsrf?: boolean; json?: boolean } = {},
): Record<string, string> {
  const includeCsrf = options.includeCsrf ?? false;
  const cookies: string[] = [];
  if (jar.at) cookies.push(`tomato_at=${jar.at}`);
  if (jar.rt) cookies.push(`tomato_rt=${jar.rt}`);
  if (jar.csrf) cookies.push(`tomato_csrf=${jar.csrf}`);

  return {
    origin: getTestOrigin(),
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': ip,
    cookie: cookies.join('; '),
    ...(options.json ? { 'Content-Type': 'application/json' } : {}),
    ...(includeCsrf && jar.csrf ? { [CSRF_HEADER_NAME]: jar.csrf } : {}),
  };
}

const createdUserIds: string[] = [];

async function seedAndLoginUser(prefix: string, fullName: string) {
  const db = getDb();
  const id = generateUuidV7();
  const publicId = generatePublicId();
  const handle = makeUniqueTag(prefix).toLowerCase();
  const email = `${handle}@sudoku-test.local`;
  const now = new Date();
  const hashed = await hashPassword(TEST_PASSWORD);

  await db.insert(users).values({
    id,
    publicId,
    username: handle,
    handle,
    handleNormalized: handle,
    fullName,
    bio: '',
    isPrivate: false,
    showActiveStatus: true,
    showReadReceipts: true,
    gender: 'other',
    dateOfBirth: '1999-05-15',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(authIdentities).values({
    id: generateUuidV7(),
    userId: id,
    provider: 'email_password',
    identifierNormalized: email.toLowerCase(),
    passwordHash: hashed.hash,
    pepperVersion: hashed.pepperVersion,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  createdUserIds.push(id);

  const ip = nextTestIp();
  const loginRes = await loginPost(
    new Request(`${getTestOrigin()}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        origin: getTestOrigin(),
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': ip,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    }),
  );
  expect(loginRes.status).toBe(200);
  const jar = extractCookies(loginRes);

  return { id, publicId, handle, ip, jar };
}

describe('Integration: Sudoku PostgreSQL 16 RLS (NOBYPASSRLS), Kỉ lục LEAST() nguyên tử & 6 Bảng xếp hạng độc lập', () => {
  beforeEach(() => {
    const redis = getRedisClient();
    const keyPrefix = `tomato:test:sudoku:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    const rateLimiter = new RateLimiter(redis, { keyPrefix });
    const auditLogService = new AuditLogService();
    const authRepo = new AuthRepository();
    const sessionService = new SessionService({ repository: authRepo, rateLimiter });
    const authService = new AuthService({
      repository: authRepo,
      sessionService,
      rateLimiter,
      loginProtection: new LoginBruteForceGuard(redis, { keyPrefix: `${keyPrefix}:bf` }),
      emailProvider: new SilentEmailProvider(),
      captchaProvider: {
        provider: 'turnstile',
        verify: async () => ({ success: true, errorCodes: [] }),
      },
      auditLogService,
      minLoginFailureResponseMs: 0,
      minResendResponseMs: 0,
    });

    const realtimeAdapter = new InMemoryRealtimeAdapter({ isolated: true });
    const notificationService = new NotificationService({
      repository: new NotificationRepository(),
      rateLimiter,
      realtimeProvider: realtimeAdapter,
    });
    const presenceService = new PresenceService({
      repository: new PresenceRepository(),
      redis,
      rateLimiter,
    });
    const socialService = new SocialService({
      repository: new SocialRepository(),
      rateLimiter,
      auditLogService,
      notificationService,
      presenceService,
    });
    const sudokuService = new SudokuService({
      repository: new SudokuRepository(),
      rateLimiter,
      enforceHumanTimeFloor: false,
    });

    setSessionServiceForTesting(sessionService);
    setAuthServiceForTesting(authService);
    setRealtimeProviderForTesting(realtimeAdapter);
    setNotificationServiceForTesting(notificationService);
    setPresenceServiceForTesting(presenceService);
    setSocialServiceForTesting(socialService);
    setSudokuServiceForTesting(sudokuService);
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await getDb().delete(users).where(inArray(users.id, createdUserIds));
      }
    } finally {
      resetSessionServiceForTesting();
      resetAuthServiceForTesting();
      resetRealtimeProviderForTesting();
      resetNotificationServiceForTesting();
      resetPresenceServiceForTesting();
      resetSocialServiceForTesting();
      resetSudokuServiceForTesting();
      await closeRedisClient();
      await closeDatabasePool();
    }
  });

  it('cưỡng chế RLS thực tế dưới role NOBYPASSRLS trên sudoku_games & sudoku_records, giữ kỉ lục LEAST() và tách biệt 6 bảng xếp hạng kèm lọc Block', async () => {
    const origin = getTestOrigin();
    const db = getDb();

    // Khởi tạo tuần tự các tài khoản kiểm thử để tránh nghẽn kết nối lúc cold start.
    const alice = await seedAndLoginUser('sdk_rls_a', 'Alice Sudoku');
    const bob = await seedAndLoginUser('sdk_rls_b', 'Bob Sudoku');
    const charlie = await seedAndLoginUser('sdk_rls_c', 'Charlie Sudoku');

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(727012)`);
      await tx.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tomato_rls_verify_role') THEN
            CREATE ROLE tomato_rls_verify_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
        END
        $$;
      `);
      await tx.execute(sql`GRANT USAGE ON SCHEMA public TO tomato_rls_verify_role`);
      await tx.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sudoku_games", "sudoku_records" TO tomato_rls_verify_role`,
      );
      await tx.execute(
        sql`GRANT EXECUTE ON FUNCTION "public"."app_current_user_id"() TO tomato_rls_verify_role`,
      );
    });

    // 1. Alice bắt đầu và hoàn thành ván Easy thứ nhất trong 52 giây.
    const startA1 = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ difficulty: 'easy' }),
      }),
    );
    expect(startA1.status).toBe(201);
    const gameA1 = (await startA1.json()) as { gamePublicId: string; puzzle: string };

    // Lùi started_at về 60s trước để thỏa mãn kiểm tra đồng hồ thực từ PostgreSQL NOW().
    await db
      .update(sudokuGames)
      .set({ startedAt: new Date(Date.now() - 60_000) })
      .where(eq(sudokuGames.publicId, gameA1.gamePublicId));

    const solvedA1 = solveUniqueSudoku(gameA1.puzzle)!;
    const completeA1 = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gameA1.gamePublicId}/complete`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          finalBoard: solvedA1,
          mistakesCount: 1,
          elapsedSeconds: 52,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: gameA1.gamePublicId }) },
    );
    expect(completeA1.status).toBe(200);
    const completeA1Json = (await completeA1.json()) as {
      isNewPersonalBest: boolean;
      personalBestSeconds: number;
      gamesWon: number;
    };
    expect(completeA1Json.isNewPersonalBest).toBe(true);
    expect(completeA1Json.personalBestSeconds).toBe(52);
    expect(completeA1Json.gamesWon).toBe(1);

    // 2. Alice chơi thêm ván Easy thứ hai chậm hơn (80s) -> gamesWon tăng lên 2 nhưng bestTimeSeconds vẫn giữ nguyên 52s!
    const startA2 = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ difficulty: 'easy' }),
      }),
    );
    const gameA2 = (await startA2.json()) as { gamePublicId: string; puzzle: string };
    await db
      .update(sudokuGames)
      .set({ startedAt: new Date(Date.now() - 90_000) })
      .where(eq(sudokuGames.publicId, gameA2.gamePublicId));

    const completeA2 = await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${gameA2.gamePublicId}/complete`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          finalBoard: solveUniqueSudoku(gameA2.puzzle)!,
          mistakesCount: 0,
          elapsedSeconds: 80,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: gameA2.gamePublicId }) },
    );
    expect(completeA2.status).toBe(200);
    const completeA2Json = (await completeA2.json()) as {
      isNewPersonalBest: boolean;
      personalBestSeconds: number;
      gamesWon: number;
    };
    expect(completeA2Json.isNewPersonalBest).toBe(false);
    expect(completeA2Json.personalBestSeconds).toBe(52);
    expect(completeA2Json.gamesWon).toBe(2);

    // 3. Kiểm chứng trực tiếp PostgreSQL RLS dưới role NOBYPASSRLS khi đóng vai Bob:
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tomato_rls_verify_role`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${bob.id}, true)`);

      // Bob KHÔNG THỂ đọc bất kỳ hàng nào của Alice trong `sudoku_games` (chứa cột `solution`).
      const bobReadsAliceGames = await tx.execute(
        sql`SELECT count(*)::int AS cnt FROM "sudoku_games" WHERE "user_id" = ${alice.id}`,
      );
      expect(Number((bobReadsAliceGames.rows[0] as { cnt: number }).cnt)).toBe(0);

      // Bob KHÔNG THỂ sửa kỉ lục của Alice trong `sudoku_records`.
      const bobUpdatesAliceRecord = await tx.execute(
        sql`UPDATE "sudoku_records" SET "best_time_seconds" = 9999 WHERE "user_id" = ${alice.id}`,
      );
      expect(bobUpdatesAliceRecord.rowCount ?? 0).toBe(0);

      // Bob cố chèn giả kỉ lục mang tên Alice -> bị PostgreSQL RLS từ chối thẳng!
      await expect(
        tx.execute(sql`
          INSERT INTO "sudoku_records" ("id", "user_id", "difficulty", "best_time_seconds", "games_won", "achieved_at", "updated_at")
          VALUES (${generateUuidV7()}, ${alice.id}, 'master', 15, 1, NOW(), NOW())
        `),
      ).rejects.toThrow();
    });

    // 4. Bob giải mức Easy nhanh hơn (38s), Charlie giải mức Master (70s):
    //    - Bảng Easy chỉ có Bob (#1 - 38s) và Alice (#2 - 52s), không lẫn Charlie.
    //    - Bảng Master chỉ có Charlie (#1 - 70s), không lẫn Easy.
    const startBobEasy = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ difficulty: 'easy' }),
      }),
    );
    const bobGame = (await startBobEasy.json()) as { gamePublicId: string; puzzle: string };
    await db
      .update(sudokuGames)
      .set({ startedAt: new Date(Date.now() - 45_000) })
      .where(eq(sudokuGames.publicId, bobGame.gamePublicId));
    await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${bobGame.gamePublicId}/complete`, {
        method: 'POST',
        headers: createHeaders(bob.jar, bob.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          finalBoard: solveUniqueSudoku(bobGame.puzzle)!,
          mistakesCount: 0,
          elapsedSeconds: 38,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: bobGame.gamePublicId }) },
    );

    const startCharlieMaster = await startSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games`, {
        method: 'POST',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({ difficulty: 'master' }),
      }),
    );
    const charlieGame = (await startCharlieMaster.json()) as {
      gamePublicId: string;
      puzzle: string;
    };
    await db
      .update(sudokuGames)
      .set({ startedAt: new Date(Date.now() - 80_000) })
      .where(eq(sudokuGames.publicId, charlieGame.gamePublicId));
    await completeSudokuPost(
      new Request(`${origin}/api/v1/games/sudoku/games/${charlieGame.gamePublicId}/complete`, {
        method: 'POST',
        headers: createHeaders(charlie.jar, charlie.ip, { includeCsrf: true, json: true }),
        body: JSON.stringify({
          finalBoard: solveUniqueSudoku(charlieGame.puzzle)!,
          mistakesCount: 0,
          elapsedSeconds: 70,
        }),
      }),
      { params: Promise.resolve({ gamePublicId: charlieGame.gamePublicId }) },
    );

    // Kiểm tra kỉ lục cá nhân 6 độ khó của Alice.
    const aliceRecordsRes = await recordsSudokuGet(
      new Request(`${origin}/api/v1/games/sudoku/records`, {
        headers: createHeaders(alice.jar, alice.ip),
      }),
    );
    expect(aliceRecordsRes.status).toBe(200);
    const aliceRecordsJson = (await aliceRecordsRes.json()) as {
      records: Record<string, { bestTimeSeconds: number | null; gamesWon: number }>;
    };
    expect(aliceRecordsJson.records.easy).toEqual(
      expect.objectContaining({ bestTimeSeconds: 52, gamesWon: 2 }),
    );
    expect(aliceRecordsJson.records.master).toEqual(
      expect.objectContaining({ bestTimeSeconds: null, gamesWon: 0 }),
    );
    expect(aliceRecordsJson.records.extreme).toEqual(
      expect.objectContaining({ bestTimeSeconds: null, gamesWon: 0 }),
    );

    // Kiểm tra bảng xếp hạng Easy và Master độc lập (lọc trong nhóm tài khoản test để không phụ thuộc dữ liệu local có sẵn).
    const testUserPublicIds = new Set([alice.publicId, bob.publicId, charlie.publicId]);
    const easyBoardBeforeBlock = (await (
      await leaderboardSudokuGet(
        new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=easy`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
      )
    ).json()) as {
      items: Array<{ rank: number; user: { public_id: string }; bestTimeSeconds: number }>;
      myRank: number | null;
    };
    expect(
      easyBoardBeforeBlock.items
        .filter((x) => testUserPublicIds.has(x.user.public_id))
        .map((x) => x.user.public_id),
    ).toEqual([bob.publicId, alice.publicId]);
    expect(easyBoardBeforeBlock.myRank).not.toBeNull();
    const rankBeforeBlock = easyBoardBeforeBlock.myRank!;

    const masterBoard = (await (
      await leaderboardSudokuGet(
        new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=master`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
      )
    ).json()) as { items: Array<{ user: { public_id: string } }>; myRank: number | null };
    expect(
      masterBoard.items
        .filter((x) => testUserPublicIds.has(x.user.public_id))
        .map((x) => x.user.public_id),
    ).toEqual([charlie.publicId]);
    expect(masterBoard.myRank).toBeNull();

    // 5. Khi Alice chặn Bob -> Bob lập tức biến mất khỏi bảng xếp hạng Easy của Alice và thứ hạng của Alice tăng lên 1 bậc!
    const blockRes = await blockPost(
      new Request(`${origin}/api/v1/social/blocks/${bob.publicId}`, {
        method: 'POST',
        headers: createHeaders(alice.jar, alice.ip, { includeCsrf: true }),
      }),
      { params: Promise.resolve({ userPublicId: bob.publicId }) },
    );
    expect(blockRes.status).toBe(200);

    const easyBoardAfterBlock = (await (
      await leaderboardSudokuGet(
        new Request(`${origin}/api/v1/games/sudoku/leaderboard?difficulty=easy`, {
          headers: createHeaders(alice.jar, alice.ip),
        }),
      )
    ).json()) as { items: Array<{ user: { public_id: string } }>; myRank: number | null };
    expect(
      easyBoardAfterBlock.items
        .filter((x) => testUserPublicIds.has(x.user.public_id))
        .map((x) => x.user.public_id),
    ).toEqual([alice.publicId]);
    expect(easyBoardAfterBlock.myRank).toBe(rankBeforeBlock - 1);
  });
});
