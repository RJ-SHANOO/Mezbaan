CREATE TABLE "commission_run_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"last_processed_period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_run_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commission_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan_type" text NOT NULL,
	"billing_cycle" text NOT NULL,
	"commission_amount_minor" bigint NOT NULL,
	"fixed_fee_amount_minor" bigint DEFAULT 0 NOT NULL,
	"total_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commission_run_cursors" ADD CONSTRAINT "commission_run_cursors_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_runs" ADD CONSTRAINT "commission_runs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_run_cursors_restaurant_idx" ON "commission_run_cursors" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_runs_restaurant_period_currency_idx" ON "commission_runs" USING btree ("restaurant_id","period_start","period_end","currency");--> statement-breakpoint
CREATE POLICY "commission_run_cursors_tenant_isolation" ON "commission_run_cursors" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "commission_runs_tenant_isolation" ON "commission_runs" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');