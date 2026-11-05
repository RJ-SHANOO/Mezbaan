CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"label" text NOT NULL,
	"device_type" text NOT NULL,
	"token_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "restaurants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"commission_rate_basis_points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "restaurants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid,
	"role_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_restaurant_id_email_idx" ON "users" USING btree ("restaurant_id","email");--> statement-breakpoint
CREATE POLICY "branches_tenant_isolation" ON "branches" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "devices_tenant_isolation" ON "devices" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "restaurants_select" ON "restaurants" AS PERMISSIVE FOR SELECT TO public USING ("restaurants"."id"::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "restaurants_insert" ON "restaurants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "restaurants_update" ON "restaurants" AS PERMISSIVE FOR UPDATE TO public USING ("restaurants"."id"::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK ("restaurants"."id"::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "restaurants_delete" ON "restaurants" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');