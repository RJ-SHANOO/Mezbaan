CREATE TABLE "goods_received_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"goods_received_note_id" uuid NOT NULL,
	"purchase_order_item_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"delivered_quantity" numeric(18, 6) NOT NULL,
	"rejected_quantity" numeric(18, 6) DEFAULT 0 NOT NULL,
	"rejection_reason_code" text,
	"invoiced_unit_cost_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_received_note_items_delivered_positive" CHECK ("goods_received_note_items"."delivered_quantity" > 0),
	CONSTRAINT "goods_received_note_items_rejected_non_negative" CHECK ("goods_received_note_items"."rejected_quantity" >= 0),
	CONSTRAINT "goods_received_note_items_rejected_not_more_than_delivered" CHECK ("goods_received_note_items"."rejected_quantity" <= "goods_received_note_items"."delivered_quantity"),
	CONSTRAINT "goods_received_note_items_invoiced_cost_non_negative" CHECK ("goods_received_note_items"."invoiced_unit_cost_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goods_received_note_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_received_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"storage_location_id" uuid NOT NULL,
	"received_by_user_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_received_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_rejection_reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_rejection_reason_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goods_received_note_items" ADD CONSTRAINT "goods_received_note_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_note_items" ADD CONSTRAINT "goods_received_note_items_goods_received_note_id_goods_received_notes_id_fk" FOREIGN KEY ("goods_received_note_id") REFERENCES "public"."goods_received_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_note_items" ADD CONSTRAINT "goods_received_note_items_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_note_items" ADD CONSTRAINT "goods_received_note_items_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_storage_location_id_storage_locations_id_fk" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_received_notes" ADD CONSTRAINT "goods_received_notes_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_rejection_reason_codes" ADD CONSTRAINT "goods_rejection_reason_codes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_rejection_reason_codes_restaurant_code_idx" ON "goods_rejection_reason_codes" USING btree ("restaurant_id","code");--> statement-breakpoint
CREATE POLICY "goods_received_note_items_tenant_isolation" ON "goods_received_note_items" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "goods_received_notes_tenant_isolation" ON "goods_received_notes" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "goods_rejection_reason_codes_tenant_isolation" ON "goods_rejection_reason_codes" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');