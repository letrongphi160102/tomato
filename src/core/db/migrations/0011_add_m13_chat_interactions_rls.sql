CREATE TABLE "message_pins" (
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by_user_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_pins_pkey" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "muted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_forwarded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "uq_messages_conversation_id_pair" UNIQUE("conversation_id","id");--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_pinned_by_user_id_users_id_fk" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "fk_message_pins_conv_message" FOREIGN KEY ("conversation_id","message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "fk_message_reactions_conv_message" FOREIGN KEY ("conversation_id","message_id") REFERENCES "public"."messages"("conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_pins_conv_pinned_at" ON "message_pins" USING btree ("conversation_id","pinned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_message_reactions_conv_msg" ON "message_reactions" USING btree ("conversation_id","message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "fk_messages_reply_to_message" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conv_participants_user_pinned" ON "conversation_participants" USING btree ("user_id","pinned_at" DESC NULLS LAST) WHERE "conversation_participants"."pinned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to" ON "messages" USING btree ("conversation_id","reply_to_message_id") WHERE "messages"."reply_to_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_message_reactions_select" ON "message_reactions" FOR SELECT USING ("public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_reactions_insert" ON "message_reactions" FOR INSERT WITH CHECK ("user_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_reactions_update" ON "message_reactions" FOR UPDATE USING ("user_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id")) WITH CHECK ("user_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_reactions_delete" ON "message_reactions" FOR DELETE USING ("user_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
ALTER TABLE "message_pins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_message_pins_select" ON "message_pins" FOR SELECT USING ("public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_pins_insert" ON "message_pins" FOR INSERT WITH CHECK ("pinned_by_user_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_message_pins_delete" ON "message_pins" FOR DELETE USING ("public"."app_is_conversation_member"("conversation_id"));
