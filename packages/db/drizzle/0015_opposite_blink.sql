CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"unit_price_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_list_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT NULL NOT NULL,
	"currency" text NOT NULL,
	"branch_id" uuid,
	"order_type" text,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_list_product_idx" ON "price_list_items" USING btree ("price_list_id","product_id") WHERE "price_list_items"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_list_variant_idx" ON "price_list_items" USING btree ("price_list_id","variant_id") WHERE "price_list_items"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_restaurant_name_version_idx" ON "price_lists" USING btree ("restaurant_id","name","version");--> statement-breakpoint
CREATE POLICY "price_list_items_tenant_isolation" ON "price_list_items" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "price_lists_tenant_isolation" ON "price_lists" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
-- P2-04: version is assigned automatically on INSERT whenever the caller doesn't
-- supply one, same pattern and same reasoning as branch_number/terminal_number
-- (P1-28) — every insert path gets a correct, sequential number without
-- duplicating this logic app-side. The UNIQUE index above is still the real
-- guarantee against a genuine concurrent-publish race; this trigger only has to
-- get it right in the common case.
CREATE OR REPLACE FUNCTION assign_price_list_version() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.version IS NULL THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version FROM price_lists WHERE restaurant_id = NEW.restaurant_id AND name = NEW.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER price_lists_assign_version BEFORE INSERT ON price_lists FOR EACH ROW EXECUTE FUNCTION assign_price_list_version();