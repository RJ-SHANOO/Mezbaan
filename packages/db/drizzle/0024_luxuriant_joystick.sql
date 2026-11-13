ALTER TABLE "order_items" ADD COLUMN "fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fired_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fired_by_user_id_users_id_fk" FOREIGN KEY ("fired_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;