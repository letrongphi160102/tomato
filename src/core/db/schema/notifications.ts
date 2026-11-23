import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { notificationTypeEnum } from './enums';
import { users } from './users';

export const notifications = pgTable(
  'notifications',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL hay payload Realtime.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    entityPublicId: varchar('entity_public_id', { length: 36 }),
    dedupeKey: varchar('dedupe_key', { length: 128 }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_notifications_recipient_created').on(
      table.recipientId,
      table.createdAt.desc(),
      table.publicId.desc(),
    ),
    index('idx_notifications_recipient_unread')
      .on(table.recipientId, table.createdAt.desc())
      .where(sql`${table.readAt} IS NULL`),
    index('idx_notifications_recipient_actor').on(table.recipientId, table.actorId),
    index('idx_notifications_actor_recipient').on(table.actorId, table.recipientId),
    // Partial unique index chống trùng lặp các thông báo chưa đọc theo cặp (recipient_id, dedupe_key).
    uniqueIndex('uq_notifications_recipient_dedupe_unread')
      .on(table.recipientId, table.dedupeKey)
      .where(sql`${table.readAt} IS NULL`),
    check('chk_notifications_no_self_notification', sql`${table.recipientId} <> ${table.actorId}`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
