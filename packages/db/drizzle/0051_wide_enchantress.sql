ALTER TABLE "recipes" DROP CONSTRAINT "recipes_exactly_one_owner";--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "item_type" text DEFAULT 'raw' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "semi_finished_item_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_semi_finished_item_id_inventory_items_id_fk" FOREIGN KEY ("semi_finished_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_restaurant_semi_finished_item_idx" ON "recipes" USING btree ("restaurant_id","semi_finished_item_id") WHERE "recipes"."semi_finished_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_exactly_one_owner" CHECK ((
        (CASE WHEN "recipes"."product_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "recipes"."variant_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "recipes"."modifier_option_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "recipes"."semi_finished_item_id" IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1);