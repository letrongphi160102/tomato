import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { messages } from './messages';
import { users } from './users';

/**
 * Bảng cảm xúc (reactions) cho từng dòng tin nhắn (M13):
 * - Mỗi người dùng có tối đa 1 biểu tượng cảm xúc trên mỗi tin nhắn (`PRIMARY KEY (message_id, user_id)`).
 * - Khóa ngoại kép `(conversation_id, message_id) REFERENCES messages(conversation_id, id) ON DELETE CASCADE`
 *   chặn tuyệt đối tham chiếu chéo giữa 2 hội thoại ngay tại tầng PostgreSQL.
 * - Bật PostgreSQL RLS dựa trực tiếp trên `conversation_id` (không đệ quy).
 */
export const messageReactions = pgTable(
  'message_reactions',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'message_reactions_pkey',
      columns: [table.messageId, table.userId],
    }),
    foreignKey({
      name: 'fk_message_reactions_conv_message',
      columns: [table.conversationId, table.messageId],
      foreignColumns: [messages.conversationId, messages.id],
    }).onDelete('cascade'),
    index('idx_message_reactions_conv_msg').on(table.conversationId, table.messageId),
  ],
);

export type MessageReactionRow = typeof messageReactions.$inferSelect;
export type NewMessageReactionRow = typeof messageReactions.$inferInsert;
