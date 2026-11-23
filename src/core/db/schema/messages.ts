import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { messageTypeEnum } from './enums';
import type { E2eePublicJwkRecord } from './user-e2ee-devices';
import { users } from './users';

export interface WrappedMessageKeyEntry {
  readonly ephemeralPublicKeyJwk: E2eePublicJwkRecord;
  readonly iv: string;
  readonly wrappedKey: string;
}

export interface MessageCryptoHeaderRecord {
  readonly v: 1;
  readonly alg: 'ECDH-P256-HKDF-AES256GCM';
  readonly iv: string;
  readonly senderDevicePublicId: string;
  readonly senderKeyFingerprint: string;
  readonly senderSigningPublicKeyJwk: E2eePublicJwkRecord;
  readonly signature: string;
  readonly ratchetStep?: number;
  readonly wrappedKeys: Readonly<Record<string, WrappedMessageKeyEntry>>;
}

export const messages = pgTable(
  'messages',
  {
    // Khóa chính nội bộ UUIDv7; tuyệt đối không lộ ra API/URL.
    id: uuid('id').primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    clientMsgId: varchar('client_msg_id', { length: 64 }).notNull(),
    messageType: messageTypeEnum('message_type').notNull(),
    ciphertext: text('ciphertext'),
    cryptoHeader: jsonb('crypto_header').$type<MessageCryptoHeaderRecord>(),
    attachmentStorageKey: text('attachment_storage_key'),
    editCount: smallint('edit_count').notNull().default(0),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    recalledAt: timestamp('recalled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_messages_conversation_seq').on(table.conversationId, table.seq),
    uniqueIndex('uq_messages_conv_sender_client_msg').on(
      table.conversationId,
      table.senderId,
      table.clientMsgId,
    ),
    index('idx_messages_conversation_seq_desc').on(table.conversationId, table.seq.desc()),
    check('chk_messages_seq_positive', sql`${table.seq} >= 1`),
    check('chk_messages_edit_count_non_negative', sql`${table.editCount} >= 0`),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
