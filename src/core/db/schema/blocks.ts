import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey(),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_blocks_blocker_blocked').on(table.blockerId, table.blockedId),
    // Index đảo chiều cho phép kiểm tra chặn hai chiều (A -> B hoặc B -> A) trong O(log n).
    index('idx_blocks_blocked_blocker').on(table.blockedId, table.blockerId),
    index('idx_blocks_blocker_created').on(table.blockerId, table.createdAt.desc()),
    check('chk_blocks_no_self_block', sql`${table.blockerId} <> ${table.blockedId}`),
  ],
);

export type BlockRow = typeof blocks.$inferSelect;
export type NewBlockRow = typeof blocks.$inferInsert;
