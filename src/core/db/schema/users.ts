import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { userGenderEnum, userStatusEnum } from './enums';

export const users = pgTable(
  'users',
  {
    // Khóa chính nội bộ sinh bằng UUIDv7 ở tầng ứng dụng để giữ B-Tree index ghi tuần tự;
    // tuyệt đối không để lộ cột `id` này ra URL hoặc HTTP response công khai.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    // Cột Giai đoạn 1 giữ nguyên đồng bộ 1-1 với `handle_normalized` để bảo toàn mọi luồng Auth M0–M5.
    username: varchar('username', { length: 30 }).notNull().unique(),
    // Định danh công khai `@user_id` Giai đoạn 2 (hiển thị chuẩn hóa thường + cột tra cứu duy nhất).
    handle: varchar('handle', { length: 30 }).notNull(),
    handleNormalized: varchar('handle_normalized', { length: 30 }).notNull(),
    fullName: varchar('full_name', { length: 50 }).notNull(),
    bio: varchar('bio', { length: 160 }).notNull().default(''),
    avatarUrl: text('avatar_url'),
    // Khóa lưu trữ nội bộ dùng để xóa ảnh cũ khi đổi/gỡ ảnh đại diện; tuyệt đối không trả ra API/DTO.
    avatarStorageKey: text('avatar_storage_key'),
    isPrivate: boolean('is_private').notNull().default(false),
    showActiveStatus: boolean('show_active_status').notNull().default(true),
    showReadReceipts: boolean('show_read_receipts').notNull().default(true),
    followersCount: integer('followers_count').notNull().default(0),
    followingCount: integer('following_count').notNull().default(0),
    handleChangedAt: timestamp('handle_changed_at', { withTimezone: true }),
    gender: userGenderEnum('gender').notNull(),
    dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
    status: userStatusEnum('status').notNull().default('pending_verification'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_users_handle_norm').on(table.handleNormalized),
    index('idx_users_handle_prefix').on(table.handleNormalized.op('varchar_pattern_ops')),
    index('idx_users_full_name_trgm').using('gin', table.fullName.op('gin_trgm_ops')),
    check('chk_users_followers_count_non_negative', sql`${table.followersCount} >= 0`),
    check('chk_users_following_count_non_negative', sql`${table.followingCount} >= 0`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
