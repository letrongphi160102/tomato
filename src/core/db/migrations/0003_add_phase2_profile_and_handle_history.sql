CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "user_handle_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"old_handle_normalized" varchar(30) NOT NULL,
	"reserved_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle_normalized" varchar(30);--> statement-breakpoint
UPDATE "users"
SET
	"handle" = CASE
		WHEN lower("username") ~ '^[a-z0-9._]{3,30}$'
			AND left(lower("username"), 1) <> '.'
			AND right(lower("username"), 1) <> '.'
			AND position('..' in lower("username")) = 0
			AND lower("username") NOT IN (
				'admin','administrator','api','auth','login','logout','register','signup','signin',
				'settings','security','profile','account','privacy','devices','messages','message',
				'chat','calls','call','explore','search','notifications','notification','home','feed',
				'u','user','users','me','media','uploads','static','assets','health','status',
				'verify-email','verify_email','forgot-password','reset-password','support','help',
				'system','root','tomato','official','moderator','mod','staff','null','undefined'
			)
		THEN lower("username")
		ELSE 'u_' || replace(left("public_id", 12), '-', '')
	END,
	"handle_normalized" = CASE
		WHEN lower("username") ~ '^[a-z0-9._]{3,30}$'
			AND left(lower("username"), 1) <> '.'
			AND right(lower("username"), 1) <> '.'
			AND position('..' in lower("username")) = 0
			AND lower("username") NOT IN (
				'admin','administrator','api','auth','login','logout','register','signup','signin',
				'settings','security','profile','account','privacy','devices','messages','message',
				'chat','calls','call','explore','search','notifications','notification','home','feed',
				'u','user','users','me','media','uploads','static','assets','health','status',
				'verify-email','verify_email','forgot-password','reset-password','support','help',
				'system','root','tomato','official','moderator','mod','staff','null','undefined'
			)
		THEN lower("username")
		ELSE 'u_' || replace(left("public_id", 12), '-', '')
	END
WHERE "handle" IS NULL OR "handle_normalized" IS NULL;--> statement-breakpoint
UPDATE "users" SET "username" = "handle_normalized" WHERE "username" <> "handle_normalized";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle_normalized" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" varchar(160) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_storage_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_active_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_read_receipts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "followers_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "following_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_handle_history" ADD CONSTRAINT "user_handle_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_handle_history_old_reserved" ON "user_handle_history" USING btree ("old_handle_normalized","reserved_until" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_handle_history_user_created" ON "user_handle_history" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_handle_norm" ON "users" USING btree ("handle_normalized");--> statement-breakpoint
CREATE INDEX "idx_users_handle_prefix" ON "users" USING btree ("handle_normalized" varchar_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_users_full_name_trgm" ON "users" USING gin ("full_name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_followers_count_non_negative" CHECK ("users"."followers_count" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_following_count_non_negative" CHECK ("users"."following_count" >= 0);
