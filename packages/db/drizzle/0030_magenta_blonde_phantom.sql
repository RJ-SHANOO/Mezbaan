CREATE TABLE "discount_limit_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"max_unapproved_percent_basis_points" integer,
	"max_unapproved_amount_minor" bigint,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_limit_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "discount_reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_reason_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_percent_basis_points" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_reason_code" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_percent_basis_points" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_reason_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "discount_limit_settings" ADD CONSTRAINT "discount_limit_settings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_limit_settings" ADD CONSTRAINT "discount_limit_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_reason_codes" ADD CONSTRAINT "discount_reason_codes_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_limit_settings_restaurant_idx" ON "discount_limit_settings" USING btree ("restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_reason_codes_restaurant_code_idx" ON "discount_reason_codes" USING btree ("restaurant_id","code");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discount_approved_by_user_id_users_id_fk" FOREIGN KEY ("discount_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_approved_by_user_id_users_id_fk" FOREIGN KEY ("discount_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_at_most_one_discount_type" CHECK (NOT ("order_items"."discount_percent_basis_points" IS NOT NULL AND "order_items"."discount_amount_minor" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_at_most_one_discount_type" CHECK (NOT ("orders"."discount_percent_basis_points" IS NOT NULL AND "orders"."discount_amount_minor" IS NOT NULL));--> statement-breakpoint
CREATE POLICY "discount_limit_settings_tenant_isolation" ON "discount_limit_settings" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "discount_reason_codes_tenant_isolation" ON "discount_reason_codes" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');