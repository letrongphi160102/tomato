ALTER TABLE "user_e2ee_devices" ADD COLUMN "is_sync_key" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "user_e2ee_devices" AS d
SET "is_sync_key" = true, "revoked_at" = NULL
FROM "user_e2ee_key_backups" AS b
WHERE d."user_id" = b."user_id"
  AND d."key_fingerprint" = b."key_fingerprint";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_e2ee_devices_user_active_sync" ON "user_e2ee_devices" USING btree ("user_id") WHERE "user_e2ee_devices"."is_sync_key" = true AND "user_e2ee_devices"."revoked_at" IS NULL;
