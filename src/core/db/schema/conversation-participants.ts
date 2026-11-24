import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { conversationInboxStateEnum } from './enums';
import { users } from './users';

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    inboxState: conversationInboxStateEnum('inbox_state').notNull(),
    pendingMessagesSent: smallint('pending_messages_sent').notNull().default(0),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    clearedBeforeSeq: bigint('cleared_before_seq', { mode: 'number' }).notNull().default(0),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'conversation_participants_pkey',
      columns: [table.conversationId, table.userId],
    }),
    index('idx_conv_participants_user_inbox').on(
      table.userId,
      table.inboxState,
      table.joinedAt.desc(),
    ),
    index('idx_conv_participants_user_pinned')
      .on(table.userId, table.pinnedAt.desc())
      .where(sql`${table.pinnedAt} IS NOT NULL`),
    check(
      'chk_conv_participants_pending_messages_range',
      sql`${table.pendingMessagesSent} >= 0 AND ${table.pendingMessagesSent} <= 3`,
    ),
    check('chk_conv_participants_last_read_seq_non_negative', sql`${table.lastReadSeq} >= 0`),
    check(
      'chk_conv_participants_cleared_before_seq_non_negative',
      sql`${table.clearedBeforeSeq} >= 0`,
    ),
  ],
);

export type ConversationParticipantRow = typeof conversationParticipants.$inferSelect;
export type NewConversationParticipantRow = typeof conversationParticipants.$inferInsert;
