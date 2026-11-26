CREATE TABLE "item_par_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"min_quantity" numeric(18, 6) NOT NULL,
	"par_quantity" numeric(18, 6) NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_par_levels_min_non_negative" CHECK ("item_par_levels"."min_quantity" >= 0),
	CONSTRAINT "item_par_levels_par_at_least_min" CHECK ("item_par_levels"."par_quantity" >= "item_par_levels"."min_quantity")
);
--> statement-breakpoint
ALTER TABLE "item_par_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_par_levels" ADD CONSTRAINT "item_par_levels_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_par_levels" ADD CONSTRAINT "item_par_levels_storage_location_id_storage_locations_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_par_levels" ADD CONSTRAINT "item_par_levels_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_par_levels" ADD CONSTRAINT "item_par_levels_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_par_levels_location_item_idx" ON "item_par_levels" USING btree ("storage_location_id","item_id");--> statement-breakpoint
CREATE POLICY "item_par_levels_tenant_isolation" ON "item_par_levels" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');