import { sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { attachmentMediaKindEnum } from './enums';
import { messages } from './messages';
import { users } from './users';

/**
 * Giới hạn kích thước tối đa của bản mã đính kèm (10 MB ảnh gốc + 64 byte overhead AES-GCM tag).
 * Dùng cho CHECK constraint tầng PostgreSQL làm lớp phòng thủ thứ hai.
 */
export const DB_MAX_ATTACHMENT_CIPHERTEXT_BYTES = 10 * 1024 * 1024 + 64;

export const messageAttachments = pgTable(
  'message_attachments',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    mediaKind: attachmentMediaKindEnum('media_kind').notNull(),
    storageKey: varchar('storage_key', { length: 128 }).notNull().unique(),
    storageUrl: text('storage_url'),
    ciphertextSizeBytes: integer('ciphertext_size_bytes').notNull(),
    ciphertextSha256: char('ciphertext_sha256', { length: 64 }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Khóa cứng quan hệ 1-1: 1 tin nhắn chỉ gắn tối đa 1 tệp và 1 tệp chỉ gắn tối đa 1 tin nhắn.
    uniqueIndex('uq_message_attachments_message_id')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    index('idx_message_attachments_conv_created').on(table.conversationId, table.createdAt.desc()),
    // Tối ưu Index Scan cho cơ chế lazy cleanup bản ghi pending quá hạn của chính người dùng.
    index('idx_message_attachments_pending_gc')
      .on(table.uploaderId, table.createdAt)
      .where(sql`${table.messageId} IS NULL AND ${table.deletedAt} IS NULL`),
    check(
      'chk_message_attachments_size_range',
      sql`${table.ciphertextSizeBytes} > 0 AND ${table.ciphertextSizeBytes} <= 10485824`,
    ),
  ],
);

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type NewMessageAttachmentRow = typeof messageAttachments.$inferInsert;
