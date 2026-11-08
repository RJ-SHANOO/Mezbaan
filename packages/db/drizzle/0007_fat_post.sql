CREATE TABLE "sync_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation_type" text NOT NULL,
	"payload" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_operations_restaurant_idempotency_idx" ON "sync_operations" USING btree ("restaurant_id","idempotency_key");--> statement-breakpoint
CREATE POLICY "sync_operations_tenant_isolation" ON "sync_operations" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');