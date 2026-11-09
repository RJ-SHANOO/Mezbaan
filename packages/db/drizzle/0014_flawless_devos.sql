CREATE TABLE "combo_slot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"combo_slot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combo_slot_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "combo_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"combo_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"min_selections" integer DEFAULT 1 NOT NULL,
	"max_selections" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combo_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "combos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "combo_slot_items" ADD CONSTRAINT "combo_slot_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slot_items" ADD CONSTRAINT "combo_slot_items_combo_slot_id_combo_slots_id_fk" FOREIGN KEY ("combo_slot_id") REFERENCES "public"."combo_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slot_items" ADD CONSTRAINT "combo_slot_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combos" ADD CONSTRAINT "combos_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "combo_slot_items_slot_product_idx" ON "combo_slot_items" USING btree ("combo_slot_id","product_id");--> statement-breakpoint
CREATE POLICY "combo_slot_items_tenant_isolation" ON "combo_slot_items" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "combo_slots_tenant_isolation" ON "combo_slots" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "combos_tenant_isolation" ON "combos" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');