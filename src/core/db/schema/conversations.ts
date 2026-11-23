import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { conversationTypeEnum } from './enums';

export const conversations = pgTable(
  'conversations',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    type: conversationTypeEnum('type').notNull().default('direct'),
    directPairKey: varchar('direct_pair_key', { length: 80 }).notNull(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_conversations_direct_pair_key').on(table.directPairKey),
    index('idx_conversations_last_message_at').on(
      table.lastMessageAt.desc(),
      table.createdAt.desc(),
    ),
    check('chk_conversations_last_seq_non_negative', sql`${table.lastSeq} >= 0`),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
