CREATE TYPE "public"."attachment_media_kind" AS ENUM('image', 'voice');--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"message_id" uuid,
	"media_kind" "attachment_media_kind" NOT NULL,
	"storage_key" varchar(128) NOT NULL,
	"storage_url" text,
	"ciphertext_size_bytes" integer NOT NULL,
	"ciphertext_sha256" char(64) NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "message_attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "chk_message_attachments_size_range" CHECK ("message_attachments"."ciphertext_size_bytes" > 0 AND "message_attachments"."ciphertext_size_bytes" <= 10485824)
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_attachments_message_id" ON "message_attachments" USING btree ("message_id") WHERE "message_attachments"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_message_attachments_conv_created" ON "message_attachments" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_message_attachments_pending_gc" ON "message_attachments" USING btree ("uploader_id","created_at") WHERE "message_attachments"."message_id" IS NULL AND "message_attachments"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_message_attachments_select" ON "message_attachments" FOR SELECT USING ("public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_attachments_insert" ON "message_attachments" FOR INSERT WITH CHECK ("uploader_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_attachments_update" ON "message_attachments" FOR UPDATE USING ("uploader_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id")) WITH CHECK ("uploader_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));