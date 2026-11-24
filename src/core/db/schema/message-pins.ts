import { foreignKey, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { messages } from './messages';
import { users } from './users';

/**
 * Bảng tin nhắn đã ghim trong từng hội thoại (M13):
 * - Tách riêng khỏi bảng `messages` để giữ nguyên chính sách RLS chặt `rls_messages_update`
 *   (chỉ `sender_id` được sửa/thu hồi tin nhắn), đồng thời cho phép cả 2 thành viên ghim/gỡ ghim.
 * - Khóa ngoại kép `(conversation_id, message_id) REFERENCES messages(conversation_id, id) ON DELETE CASCADE`
 *   chặn tuyệt đối tráo `conversation_id` ở tầng PostgreSQL.
 * - Giới hạn tối đa 5 tin ghim mỗi hội thoại được cưỡng chế nguyên tử dưới `FOR UPDATE` trên `conversations`.
 */
export const messagePins = pgTable(
  'message_pins',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    pinnedByUserId: uuid('pinned_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'message_pins_pkey',
      columns: [table.conversationId, table.messageId],
    }),
    foreignKey({
      name: 'fk_message_pins_conv_message',
      columns: [table.conversationId, table.messageId],
      foreignColumns: [messages.conversationId, messages.id],
    }).onDelete('cascade'),
    index('idx_message_pins_conv_pinned_at').on(table.conversationId, table.pinnedAt.desc()),
  ],
);

export type MessagePinRow = typeof messagePins.$inferSelect;
export type NewMessagePinRow = typeof messagePins.$inferInsert;
