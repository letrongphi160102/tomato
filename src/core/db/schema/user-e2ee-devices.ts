import { sql } from 'drizzle-orm';
import {
  char,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from './users';

export interface E2eePublicJwkRecord {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly ext?: boolean;
  key_ops?: string[];
}

export const userE2eeDevices = pgTable(
  'user_e2ee_devices',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionFamilyId: uuid('session_family_id'),
    deviceLabel: varchar('device_label', { length: 64 }).notNull().default('Trình duyệt web'),
    identityPublicKeyJwk: jsonb('identity_public_key_jwk').$type<E2eePublicJwkRecord>().notNull(),
    signingPublicKeyJwk: jsonb('signing_public_key_jwk').$type<E2eePublicJwkRecord>().notNull(),
    keyFingerprint: char('key_fingerprint', { length: 64 }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_user_e2ee_devices_user_fingerprint').on(table.userId, table.keyFingerprint),
    index('idx_user_e2ee_devices_user_active')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export type UserE2eeDeviceRow = typeof userE2eeDevices.$inferSelect;
export type NewUserE2eeDeviceRow = typeof userE2eeDevices.$inferInsert;
