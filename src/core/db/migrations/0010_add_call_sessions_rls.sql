CREATE TYPE "public"."call_status" AS ENUM('ringing', 'connected', 'ended', 'missed', 'declined', 'busy');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('audio', 'video');--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_id" uuid NOT NULL,
	"call_type" "call_type" NOT NULL,
	"status" "call_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_sessions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "chk_call_sessions_distinct_users" CHECK ("call_sessions"."caller_id" <> "call_sessions"."callee_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "call_event_meta" jsonb;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_call_sessions_conversation_started" ON "call_sessions" USING btree ("conversation_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_call_sessions_caller_active" ON "call_sessions" USING btree ("caller_id","started_at" DESC NULLS LAST) WHERE "call_sessions"."status" IN ('ringing', 'connected');--> statement-breakpoint
CREATE INDEX "idx_call_sessions_callee_active" ON "call_sessions" USING btree ("callee_id","started_at" DESC NULLS LAST) WHERE "call_sessions"."status" IN ('ringing', 'connected');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."app_user_has_active_call"(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "public"."call_sessions" cs
    WHERE (cs."caller_id" = target_user_id OR cs."callee_id" = target_user_id)
      AND (
        (cs."status" = 'ringing' AND cs."started_at" > NOW() - INTERVAL '45 seconds')
        OR
        (cs."status" = 'connected' AND COALESCE(cs."last_heartbeat_at", cs."connected_at", cs."started_at") > NOW() - INTERVAL '120 seconds')
      )
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."app_sweep_stale_calls_for_user"(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE "public"."call_sessions"
  SET "status" = 'missed',
      "ended_at" = NOW()
  WHERE ("caller_id" = target_user_id OR "callee_id" = target_user_id)
    AND "status" = 'ringing'
    AND "started_at" <= NOW() - INTERVAL '45 seconds';

  UPDATE "public"."call_sessions"
  SET "status" = 'ended',
      "ended_at" = NOW()
  WHERE ("caller_id" = target_user_id OR "callee_id" = target_user_id)
    AND "status" = 'connected'
    AND COALESCE("last_heartbeat_at", "connected_at", "started_at") <= NOW() - INTERVAL '120 seconds';
END;
$$;--> statement-breakpoint
ALTER TABLE "call_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_call_sessions_select" ON "call_sessions" FOR SELECT USING ("caller_id" = "public"."app_current_user_id"() OR "callee_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_call_sessions_insert" ON "call_sessions" FOR INSERT WITH CHECK ("caller_id" = "public"."app_current_user_id"() AND "public"."app_is_conversation_member"("conversation_id"));--> statement-breakpoint
CREATE POLICY "rls_call_sessions_update" ON "call_sessions" FOR UPDATE USING ("caller_id" = "public"."app_current_user_id"() OR "callee_id" = "public"."app_current_user_id"()) WITH CHECK ("caller_id" = "public"."app_current_user_id"() OR "callee_id" = "public"."app_current_user_id"());
