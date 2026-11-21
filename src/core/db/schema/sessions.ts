import { char, index, inet, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Gom nhóm chuỗi xoay vòng Refresh Token nhằm thu hồi toàn bộ family khi phát hiện reuse attack.
    familyId: uuid('family_id').notNull(),
    // Chỉ lưu bản băm SHA-256 hex (64 ký tự) của Refresh Token, không bao giờ lưu token gốc.
    refreshTokenHash: char('refresh_token_hash', { length: 64 }).notNull().unique(),
    deviceInfo: varchar('device_info', { length: 255 }),
    ipAddress: inet('ip_address').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: varchar('revoke_reason', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_user_active').on(table.userId, table.revokedAt),
    index('idx_sessions_family_id').on(table.familyId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
