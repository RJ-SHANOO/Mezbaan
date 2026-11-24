ALTER TABLE "stock_counts" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;