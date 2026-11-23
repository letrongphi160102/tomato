import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { followStatusEnum } from './enums';
import { users } from './users';

export const follows = pgTable(
  'follows',
  {
    id: uuid('id').primaryKey(),
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: followStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_follows_follower_followee').on(table.followerId, table.followeeId),
    index('idx_follows_followee_status_created').on(
      table.followeeId,
      table.status,
      table.createdAt.desc(),
    ),
    index('idx_follows_follower_status_created').on(
      table.followerId,
      table.status,
      table.createdAt.desc(),
    ),
    check('chk_follows_no_self_follow', sql`${table.followerId} <> ${table.followeeId}`),
  ],
);

export type FollowRow = typeof follows.$inferSelect;
export type NewFollowRow = typeof follows.$inferInsert;
