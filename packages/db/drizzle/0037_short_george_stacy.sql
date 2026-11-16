CREATE TABLE "receipt_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"logo_url" text,
	"header_text" text,
	"footer_text" text,
	"show_tax_breakdown" boolean DEFAULT true NOT NULL,
	"show_service_charge" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_settings" ADD CONSTRAINT "receipt_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_settings_restaurant_idx" ON "receipt_settings" USING btree ("restaurant_id");--> statement-breakpoint
CREATE POLICY "receipt_settings_tenant_isolation" ON "receipt_settings" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');