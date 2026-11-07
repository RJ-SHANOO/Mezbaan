ALTER TABLE "devices" ADD COLUMN "pairing_code_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "pairing_code_expires_at" timestamp with time zone;