import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { sudokuDifficultyEnum, sudokuGameStatusEnum } from './enums';
import { users } from './users';

export const sudokuGames = pgTable(
  'sudoku_games',
  {
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    difficulty: sudokuDifficultyEnum('difficulty').notNull(),
    puzzle: varchar('puzzle', { length: 81 }).notNull(),
    solution: varchar('solution', { length: 81 }).notNull(),
    status: sudokuGameStatusEnum('status').notNull().default('in_progress'),
    mistakesCount: smallint('mistakes_count').notNull().default(0),
    elapsedSeconds: integer('elapsed_seconds'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_sudoku_games_user_started').on(table.userId, table.status, table.startedAt.desc()),
    check(
      'chk_sudoku_games_mistakes_range',
      sql`${table.mistakesCount} >= 0 AND ${table.mistakesCount} <= 3`,
    ),
    check(
      'chk_sudoku_games_elapsed_positive',
      sql`${table.elapsedSeconds} IS NULL OR ${table.elapsedSeconds} > 0`,
    ),
  ],
);

export type SudokuGameRow = typeof sudokuGames.$inferSelect;
export type NewSudokuGameRow = typeof sudokuGames.$inferInsert;
