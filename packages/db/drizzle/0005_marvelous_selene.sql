CREATE TABLE "app_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"version" text NOT NULL,
	"url" text NOT NULL,
	"signature" text NOT NULL,
	"notes" text,
	"rollout_percentage" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_releases_platform_version_idx" ON "app_releases" USING btree ("platform","version");