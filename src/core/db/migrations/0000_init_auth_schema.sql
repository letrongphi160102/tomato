CREATE TYPE "public"."auth_provider" AS ENUM('email_password');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending_verification', 'active', 'locked', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."verification_token_purpose" AS ENUM('email_verify', 'password_reset', 'password_change');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" varchar(64) NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"identifier_normalized" varchar(255) NOT NULL,
	"password_hash" text,
	"pepper_version" smallint DEFAULT 1 NOT NULL,
	"verified_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"refresh_token_hash" char(64) NOT NULL,
	"device_info" varchar(255),
	"ip_address" "inet" NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"display_name" varchar(50) NOT NULL,
	"date_of_birth" date NOT NULL,
	"status" "user_status" DEFAULT 'pending_verification' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "verification_token_purpose" NOT NULL,
	"token_hash" char(64) NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_user_created" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identities_provider_identifier" ON "auth_identities" USING btree ("provider","identifier_normalized");--> statement-breakpoint
CREATE INDEX "idx_identities_user_id" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_active" ON "sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_family_id" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "idx_vtokens_user_purpose" ON "verification_tokens" USING btree ("user_id","purpose","consumed_at");--> statement-breakpoint
CREATE INDEX "idx_vtokens_hash" ON "verification_tokens" USING btree ("token_hash");