import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authProviderEnum } from './enums';
import { users } from './users';

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    // Lưu định danh đã chuẩn hóa (trim + NFKC + lowercase) để ràng buộc UNIQUE chống trùng tài khoản/race condition.
    identifierNormalized: varchar('identifier_normalized', { length: 255 }).notNull(),
    passwordHash: text('password_hash'),
    pepperVersion: smallint('pepper_version').notNull().default(1),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_identities_provider_identifier').on(
      table.provider,
      table.identifierNormalized,
    ),
    index('idx_identities_user_id').on(table.userId),
  ],
);

export type AuthIdentityRow = typeof authIdentities.$inferSelect;
export type NewAuthIdentityRow = typeof authIdentities.$inferInsert;
