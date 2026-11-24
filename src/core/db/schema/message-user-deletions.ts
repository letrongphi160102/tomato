import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { messages } from './messages';
import { users } from './users';

export const messageUserDeletions = pgTable(
  'message_user_deletions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'message_user_deletions_pkey',
      columns: [table.messageId, table.userId],
    }),
    index('idx_message_user_deletions_user_deleted_at').on(table.userId, table.deletedAt.desc()),
  ],
);

export type MessageUserDeletionRow = typeof messageUserDeletions.$inferSelect;
export type NewMessageUserDeletionRow = typeof messageUserDeletions.$inferInsert;
