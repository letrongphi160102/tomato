CREATE TYPE "public"."notification_type" AS ENUM('follow_request', 'follow_accepted', 'new_follower', 'message_request');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"recipient_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"entity_public_id" varchar(36),
	"dedupe_key" varchar(128) NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "chk_notifications_no_self_notification" CHECK ("notifications"."recipient_id" <> "notifications"."actor_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_created" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST,"public_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_unread" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_actor" ON "notifications" USING btree ("recipient_id","actor_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_actor_recipient" ON "notifications" USING btree ("actor_id","recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_recipient_dedupe_unread" ON "notifications" USING btree ("recipient_id","dedupe_key") WHERE "notifications"."read_at" IS NULL;