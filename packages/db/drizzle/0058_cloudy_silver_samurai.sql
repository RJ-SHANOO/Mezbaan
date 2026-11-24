CREATE TABLE "supplier_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_items_quantity_positive" CHECK ("supplier_invoice_items"."quantity" > 0),
	CONSTRAINT "supplier_invoice_items_unit_cost_non_negative" CHECK ("supplier_invoice_items"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_invoice_match_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"supplier_invoice_item_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"invoiced_quantity" numeric(18, 6) NOT NULL,
	"ordered_quantity" numeric(18, 6) NOT NULL,
	"received_quantity" numeric(18, 6) NOT NULL,
	"invoiced_unit_cost_minor" bigint NOT NULL,
	"ordered_unit_cost_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"mismatched_fields" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_invoice_number" text NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_items" ADD CONSTRAINT "supplier_invoice_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_supplier_invoice_item_id_supplier_invoice_items_id_fk" FOREIGN KEY ("supplier_invoice_item_id") REFERENCES "public"."supplier_invoice_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_match_flags" ADD CONSTRAINT "supplier_invoice_match_flags_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoice_match_flags_restaurant_created_idx" ON "supplier_invoice_match_flags" USING btree ("restaurant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_supplier_number_idx" ON "supplier_invoices" USING btree ("restaurant_id","supplier_id","supplier_invoice_number");--> statement-breakpoint
CREATE POLICY "supplier_invoice_items_tenant_isolation" ON "supplier_invoice_items" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "supplier_invoice_match_flags_tenant_isolation" ON "supplier_invoice_match_flags" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "supplier_invoices_tenant_isolation" ON "supplier_invoices" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');