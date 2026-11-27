CREATE TYPE "public"."sudoku_difficulty" AS ENUM('easy', 'medium', 'hard', 'expert', 'master', 'extreme');--> statement-breakpoint
CREATE TYPE "public"."sudoku_game_status" AS ENUM('in_progress', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE "sudoku_games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" varchar(36) NOT NULL,
	"user_id" uuid NOT NULL,
	"difficulty" "sudoku_difficulty" NOT NULL,
	"puzzle" varchar(81) NOT NULL,
	"solution" varchar(81) NOT NULL,
	"status" "sudoku_game_status" DEFAULT 'in_progress' NOT NULL,
	"mistakes_count" smallint DEFAULT 0 NOT NULL,
	"elapsed_seconds" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sudoku_games_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "chk_sudoku_games_mistakes_range" CHECK ("sudoku_games"."mistakes_count" >= 0 AND "sudoku_games"."mistakes_count" <= 3),
	CONSTRAINT "chk_sudoku_games_elapsed_positive" CHECK ("sudoku_games"."elapsed_seconds" IS NULL OR "sudoku_games"."elapsed_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "sudoku_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"difficulty" "sudoku_difficulty" NOT NULL,
	"best_time_seconds" integer NOT NULL,
	"games_won" integer DEFAULT 1 NOT NULL,
	"best_game_id" uuid,
	"achieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_sudoku_records_best_time_positive" CHECK ("sudoku_records"."best_time_seconds" > 0),
	CONSTRAINT "chk_sudoku_records_games_won_positive" CHECK ("sudoku_records"."games_won" >= 1)
);
--> statement-breakpoint
ALTER TABLE "sudoku_games" ADD CONSTRAINT "sudoku_games_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sudoku_records" ADD CONSTRAINT "sudoku_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sudoku_records" ADD CONSTRAINT "sudoku_records_best_game_id_sudoku_games_id_fk" FOREIGN KEY ("best_game_id") REFERENCES "public"."sudoku_games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sudoku_games_user_started" ON "sudoku_games" USING btree ("user_id","status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sudoku_records_user_difficulty" ON "sudoku_records" USING btree ("user_id","difficulty");--> statement-breakpoint
CREATE INDEX "idx_sudoku_records_leaderboard" ON "sudoku_records" USING btree ("difficulty","best_time_seconds","achieved_at");--> statement-breakpoint
ALTER TABLE "sudoku_games" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_sudoku_games_select" ON "sudoku_games" FOR SELECT USING ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_sudoku_games_insert" ON "sudoku_games" FOR INSERT WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_sudoku_games_update" ON "sudoku_games" FOR UPDATE USING ("user_id" = "public"."app_current_user_id"()) WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_sudoku_games_delete" ON "sudoku_games" FOR DELETE USING ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
ALTER TABLE "sudoku_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rls_sudoku_records_select" ON "sudoku_records" FOR SELECT USING ("public"."app_current_user_id"() IS NOT NULL);--> statement-breakpoint
CREATE POLICY "rls_sudoku_records_insert" ON "sudoku_records" FOR INSERT WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_sudoku_records_update" ON "sudoku_records" FOR UPDATE USING ("user_id" = "public"."app_current_user_id"()) WITH CHECK ("user_id" = "public"."app_current_user_id"());--> statement-breakpoint
CREATE POLICY "rls_sudoku_records_delete" ON "sudoku_records" FOR DELETE USING ("user_id" = "public"."app_current_user_id"());
