import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { sudokuDifficultyEnum } from './enums';
import { sudokuGames } from './sudoku-games';
import { users } from './users';

export const sudokuRecords = pgTable(
  'sudoku_records',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    difficulty: sudokuDifficultyEnum('difficulty').notNull(),
    bestTimeSeconds: integer('best_time_seconds').notNull(),
    gamesWon: integer('games_won').notNull().default(1),
    bestGameId: uuid('best_game_id').references(() => sudokuGames.id, { onDelete: 'set null' }),
    achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_sudoku_records_user_difficulty').on(table.userId, table.difficulty),
    index('idx_sudoku_records_leaderboard').on(
      table.difficulty,
      table.bestTimeSeconds.asc(),
      table.achievedAt.asc(),
    ),
    check('chk_sudoku_records_best_time_positive', sql`${table.bestTimeSeconds} > 0`),
    check('chk_sudoku_records_games_won_positive', sql`${table.gamesWon} >= 1`),
  ],
);

export type SudokuRecordRow = typeof sudokuRecords.$inferSelect;
export type NewSudokuRecordRow = typeof sudokuRecords.$inferInsert;
