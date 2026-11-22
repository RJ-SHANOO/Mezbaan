CREATE TABLE "negative_stock_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"stock_ledger_id" uuid NOT NULL,
	"quantity_after" numeric(18, 6) NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_storage_location_id_storage_locations_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_stock_ledger_id_stock_ledger_id_fk" FOREIGN KEY ("stock_ledger_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negative_stock_flags" ADD CONSTRAINT "negative_stock_flags_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "negative_stock_flags_restaurant_created_idx" ON "negative_stock_flags" USING btree ("restaurant_id","created_at");--> statement-breakpoint
CREATE POLICY "negative_stock_flags_tenant_isolation" ON "negative_stock_flags" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');