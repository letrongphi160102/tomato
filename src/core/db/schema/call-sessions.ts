import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { callStatusEnum, callTypeEnum } from './enums';
import { users } from './users';

export const callSessions = pgTable(
  'call_sessions',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL/Realtime.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calleeId: uuid('callee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    callType: callTypeEnum('call_type').notNull(),
    status: callStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_call_sessions_conversation_started').on(
      table.conversationId,
      table.startedAt.desc(),
    ),
    index('idx_call_sessions_caller_active')
      .on(table.callerId, table.startedAt.desc())
      .where(sql`${table.status} IN ('ringing', 'connected')`),
    index('idx_call_sessions_callee_active')
      .on(table.calleeId, table.startedAt.desc())
      .where(sql`${table.status} IN ('ringing', 'connected')`),
    check('chk_call_sessions_distinct_users', sql`${table.callerId} <> ${table.calleeId}`),
  ],
);

export type CallSessionRow = typeof callSessions.$inferSelect;
export type NewCallSessionRow = typeof callSessions.$inferInsert;
