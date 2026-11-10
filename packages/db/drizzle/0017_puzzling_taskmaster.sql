CREATE TABLE "product_stock_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"reason" text,
	"marked_by_user_id" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_stock_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_stock_status" ADD CONSTRAINT "product_stock_status_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_status" ADD CONSTRAINT "product_stock_status_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_status" ADD CONSTRAINT "product_stock_status_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_status" ADD CONSTRAINT "product_stock_status_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_status" ADD CONSTRAINT "product_stock_status_marked_by_user_id_users_id_fk" FOREIGN KEY ("marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_stock_status_branch_product_idx" ON "product_stock_status" USING btree ("branch_id","product_id") WHERE "product_stock_status"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_stock_status_branch_variant_idx" ON "product_stock_status" USING btree ("branch_id","variant_id") WHERE "product_stock_status"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "product_stock_status_tenant_isolation" ON "product_stock_status" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');