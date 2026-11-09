CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_status_available_at_idx" ON "outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE POLICY "outbox_tenant_isolation" ON "outbox" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');