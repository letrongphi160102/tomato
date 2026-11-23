CREATE TYPE "public"."conversation_inbox_state" AS ENUM('primary', 'pending', 'declined');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('direct');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'voice', 'call_event');--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"inbox_state" "conversation_inbox_state" NOT NULL,
	"pending_messages_sent" smallint DEFAULT 0 NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"cleared_before_seq" bigint DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_pkey" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "chk_conv_participants_pending_messages_range" CHECK ("conversation_participants"."pending_messages_sent" >= 0 AND "conversation_participants"."pending_messages_sent" <= 3),
	CONSTRAINT "chk_conv_participants_last_read_seq_non_negative" CHECK ("conversation_participants"."last_read_seq" >= 0),
	CONSTRAINT "chk_conv_participants_cleared_before_seq_non_negative" CHECK ("conversation_participants"."cleared_before_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"type" "conversation_type" DEFAULT 'direct' NOT NULL,
	"direct_pair_key" varchar(80) NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "chk_conversations_last_seq_non_negative" CHECK ("conversations"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"client_msg_id" varchar(64) NOT NULL,
	"message_type" "message_type" NOT NULL,
	"ciphertext" text,
	"crypto_header" jsonb,
	"attachment_storage_key" text,
	"edit_count" smallint DEFAULT 0 NOT NULL,
	"edited_at" timestamp with time zone,
	"recalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "chk_messages_seq_positive" CHECK ("messages"."seq" >= 1),
	CONSTRAINT "chk_messages_edit_count_non_negative" CHECK ("messages"."edit_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_e2ee_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"user_id" uuid NOT NULL,
	"session_family_id" uuid,
	"device_label" varchar(64) DEFAULT 'Trình duyệt web' NOT NULL,
	"identity_public_key_jwk" jsonb NOT NULL,
	"signing_public_key_jwk" jsonb NOT NULL,
	"key_fingerprint" char(64) NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_e2ee_devices_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "user_e2ee_key_backups" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_key_blob" text NOT NULL,
	"kdf_salt" varchar(64) NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"iv" varchar(32) NOT NULL,
	"key_fingerprint" char(64) NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_e2ee_devices" ADD CONSTRAINT "user_e2ee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_e2ee_key_backups" ADD CONSTRAINT "user_e2ee_key_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conv_participants_user_inbox" ON "conversation_participants" USING btree ("user_id","inbox_state","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_direct_pair_key" ON "conversations" USING btree ("direct_pair_key");--> statement-breakpoint
CREATE INDEX "idx_conversations_last_message_at" ON "conversations" USING btree ("last_message_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_conversation_seq" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_conv_sender_client_msg" ON "messages" USING btree ("conversation_id","sender_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_seq_desc" ON "messages" USING btree ("conversation_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_e2ee_devices_user_fingerprint" ON "user_e2ee_devices" USING btree ("user_id","key_fingerprint");--> statement-breakpoint
CREATE INDEX "idx_user_e2ee_devices_user_active" ON "user_e2ee_devices" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "user_e2ee_devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."app_current_user_id"()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."app_is_conversation_member"(conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "public"."conversation_participants" cp
    WHERE cp."conversation_id" = conv_id
      AND cp."user_id" = "public"."app_current_user_id"()
  );
$$;--> statement-breakpoint
ALTER TABLE "user_e2ee_key_backups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_e2ee_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_user_e2ee_key_backups_owner" ON "user_e2ee_key_backups" FOR ALL USING ("user_id" = "public"."app_current_user_id"()) WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_user_e2ee_devices_select" ON "user_e2ee_devices" FOR SELECT USING ("public"."app_current_user_id"() IS NOT NULL);--> statement-breakpoint
CREATE POLICY "rls_user_e2ee_devices_modify" ON "user_e2ee_devices" FOR ALL USING ("user_id" = "public"."app_current_user_id"()) WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_conversations_select" ON "conversations" FOR SELECT USING ("public"."app_is_conversation_member"("id"));--> statement-breakpoint
CREATE POLICY "rls_conversations_insert" ON "conversations" FOR INSERT WITH CHECK ("public"."app_current_user_id"() IS NOT NULL);--> statement-breakpoint
CREATE POLICY "rls_conversations_update" ON "conversations" FOR UPDATE USING ("public"."app_is_conversation_member"("id")) WITH CHECK ("public"."app_is_conversation_member"("id"));--> statement-breakpoint
CREATE POLICY "rls_conversation_participants_select" ON "conversation_participants" FOR SELECT USING ("user_id" = "public"."app_current_user_id"() OR "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_conversation_participants_insert" ON "conversation_participants" FOR INSERT WITH CHECK ("user_id" = "public"."app_current_user_id"() OR "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_conversation_participants_update" ON "conversation_participants" FOR UPDATE USING ("user_id" = "public"."app_current_user_id"() OR "public"."app_is_conversation_member"("conversation_id")) WITH CHECK ("user_id" = "public"."app_current_user_id"() OR "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_messages_select" ON "messages" FOR SELECT USING ("public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_messages_insert" ON "messages" FOR INSERT WITH CHECK ("sender_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_messages_update" ON "messages" FOR UPDATE USING ("sender_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id")) WITH CHECK ("sender_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));