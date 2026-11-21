import { date, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { userGenderEnum, userStatusEnum } from './enums';

export const users = pgTable('users', {
  // Khóa chính nội bộ sinh bằng UUIDv7 ở tầng ứng dụng để giữ B-Tree index ghi tuần tự;
  // tuyệt đối không để lộ cột `id` này ra URL hoặc HTTP response công khai.
  id: uuid('id').primaryKey(),
  publicId: varchar('public_id', { length: 36 }).notNull().unique(),
  // ID tài khoản dạng `@username` (giống TikTok/Instagram): chữ thường, không khoảng trắng, duy nhất.
  username: varchar('username', { length: 30 }).notNull().unique(),
  fullName: varchar('full_name', { length: 50 }).notNull(),
  gender: userGenderEnum('gender').notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
  status: userStatusEnum('status').notNull().default('pending_verification'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
