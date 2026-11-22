CREATE TABLE "kitchen_ticket_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"station_id" uuid,
	"bumped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bumped_by_user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ADD CONSTRAINT "kitchen_ticket_states_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ADD CONSTRAINT "kitchen_ticket_states_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ADD CONSTRAINT "kitchen_ticket_states_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ADD CONSTRAINT "kitchen_ticket_states_station_id_kitchen_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."kitchen_stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_states" ADD CONSTRAINT "kitchen_ticket_states_bumped_by_user_id_users_id_fk" FOREIGN KEY ("bumped_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_ticket_states_order_fired_station_idx" ON "kitchen_ticket_states" USING btree ("order_id","fired_at","station_id") WHERE "kitchen_ticket_states"."station_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_ticket_states_order_fired_unrouted_idx" ON "kitchen_ticket_states" USING btree ("order_id","fired_at") WHERE "kitchen_ticket_states"."station_id" IS NULL;--> statement-breakpoint
CREATE POLICY "kitchen_ticket_states_tenant_isolation" ON "kitchen_ticket_states" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');