import { char, index, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';

import { verificationTokenPurposeEnum } from './enums';
import { users } from './users';

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: verificationTokenPurposeEnum('purpose').notNull(),
    // SHA-256 hex (64 ký tự) cho token >= 256-bit hoặc HMAC-SHA256 hex (OTP_SECRET) cho mã OTP 6 số.
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    attemptCount: smallint('attempt_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_vtokens_user_purpose').on(table.userId, table.purpose, table.consumedAt),
    index('idx_vtokens_hash').on(table.tokenHash),
  ],
);

export type VerificationTokenRow = typeof verificationTokens.$inferSelect;
export type NewVerificationTokenRow = typeof verificationTokens.$inferInsert;
