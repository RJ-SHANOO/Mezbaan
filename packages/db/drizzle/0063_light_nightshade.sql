CREATE TABLE "wastage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"reason_code" text NOT NULL,
	"cost_minor" bigint,
	"currency" text,
	"required_approval" boolean NOT NULL,
	"approved_by_user_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wastage_entries_quantity_positive" CHECK ("wastage_entries"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "wastage_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wastage_limit_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"max_unapproved_cost_minor" bigint,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wastage_limit_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wastage_reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wastage_reason_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_storage_location_id_storage_locations_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_limit_settings" ADD CONSTRAINT "wastage_limit_settings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_limit_settings" ADD CONSTRAINT "wastage_limit_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_reason_codes" ADD CONSTRAINT "wastage_reason_codes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wastage_limit_settings_restaurant_idx" ON "wastage_limit_settings" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wastage_reason_codes_restaurant_code_idx" ON "wastage_reason_codes" USING btree ("restaurant_id","code");--> statement-breakpoint
CREATE POLICY "wastage_entries_tenant_isolation" ON "wastage_entries" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "wastage_limit_settings_tenant_isolation" ON "wastage_limit_settings" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "wastage_reason_codes_tenant_isolation" ON "wastage_reason_codes" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');