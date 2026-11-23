import {
  char,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from './users';

export interface E2eeBackupKdfParamsRecord {
  readonly alg: 'PBKDF2-SHA256';
  readonly iterations: number;
}

export const userE2eeKeyBackups = pgTable('user_e2ee_key_backups', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedKeyBlob: text('encrypted_key_blob').notNull(),
  kdfSalt: varchar('kdf_salt', { length: 64 }).notNull(),
  kdfParams: jsonb('kdf_params').$type<E2eeBackupKdfParamsRecord>().notNull(),
  iv: varchar('iv', { length: 32 }).notNull(),
  keyFingerprint: char('key_fingerprint', { length: 64 }).notNull(),
  version: smallint('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserE2eeKeyBackupRow = typeof userE2eeKeyBackups.$inferSelect;
export type NewUserE2eeKeyBackupRow = typeof userE2eeKeyBackups.$inferInsert;
