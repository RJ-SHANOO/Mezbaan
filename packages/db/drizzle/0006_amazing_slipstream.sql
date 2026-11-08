CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_restaurant_module_idx" ON "feature_flags" USING btree ("restaurant_id","module_key");--> statement-breakpoint
CREATE POLICY "feature_flags_select" ON "feature_flags" AS PERMISSIVE FOR SELECT TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "feature_flags_insert" ON "feature_flags" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "feature_flags_update" ON "feature_flags" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.is_super_admin', true) = 'true') WITH CHECK (current_setting('app.is_super_admin', true) = 'true');--> statement-breakpoint
CREATE POLICY "feature_flags_delete" ON "feature_flags" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.is_super_admin', true) = 'true');