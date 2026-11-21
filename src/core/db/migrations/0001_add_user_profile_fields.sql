CREATE TYPE "public"."user_gender" AS ENUM('male', 'female', 'other');--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "display_name" TO "full_name";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" varchar(30);--> statement-breakpoint
UPDATE "users" SET "username" = 'user_' || replace(left("public_id", 12), '-', '') WHERE "username" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" "user_gender" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "gender" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");
