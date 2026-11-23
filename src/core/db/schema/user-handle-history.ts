import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users';

export const userHandleHistory = pgTable(
  'user_handle_history',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    oldHandleNormalized: varchar('old_handle_normalized', { length: 30 }).notNull(),
    reservedUntil: timestamp('reserved_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_handle_history_old_reserved').on(
      table.oldHandleNormalized,
      table.reservedUntil.desc(),
    ),
    index('idx_user_handle_history_user_created').on(table.userId, table.createdAt.desc()),
  ],
);

export type UserHandleHistoryRow = typeof userHandleHistory.$inferSelect;
export type NewUserHandleHistoryRow = typeof userHandleHistory.$inferInsert;
