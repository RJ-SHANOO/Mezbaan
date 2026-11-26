CREATE TABLE "billing_plan_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"plan_type" text DEFAULT 'commission_only' NOT NULL,
	"fixed_fee_minor" bigint,
	"fixed_fee_currency" text,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plan_settings_hybrid_fee_pair" CHECK (("billing_plan_settings"."plan_type" = 'hybrid' AND "billing_plan_settings"."fixed_fee_minor" IS NOT NULL AND "billing_plan_settings"."fixed_fee_currency" IS NOT NULL) OR ("billing_plan_settings"."plan_type" = 'commission_only' AND "billing_plan_settings"."fixed_fee_minor" IS NULL AND "billing_plan_settings"."fixed_fee_currency" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "billing_plan_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_plan_settings" ADD CONSTRAINT "billing_plan_settings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_settings_restaurant_idx" ON "billing_plan_settings" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "billing_plan_settings_select" ON "billing_plan_settings" AS PERMISSIVE FOR SELECT TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "billing_plan_settings_insert" ON "billing_plan_settings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "billing_plan_settings_update" ON "billing_plan_settings" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.is_super_admin', true) = 'true') WITH CHECK (current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "billing_plan_settings_delete" ON "billing_plan_settings" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.is_super_admin', true) = 'true');