CREATE TABLE "message_user_deletions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_user_deletions_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "message_user_deletions" ADD CONSTRAINT "message_user_deletions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_user_deletions" ADD CONSTRAINT "message_user_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_user_deletions_user_deleted_at" ON "message_user_deletions" USING btree ("user_id","deleted_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "chk_messages_edit_count_max" CHECK ("messages"."edit_count" <= 5);--> statement-breakpoint
ALTER TABLE "message_user_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_message_user_deletions_owner" ON "message_user_deletions" FOR ALL USING ("user_id" = "public"."app_current_user_id"()) WITH CHECK ("user_id" = "public"."app_current_user_id"());
