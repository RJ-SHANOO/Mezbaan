ALTER TABLE "recipes" DROP CONSTRAINT "recipes_exactly_one_product_or_variant";--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "modifier_option_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_modifier_option_id_modifier_options_id_fk" FOREIGN KEY ("modifier_option_id") REFERENCES "public"."modifier_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_restaurant_modifier_option_idx" ON "recipes" USING btree ("restaurant_id","modifier_option_id") WHERE "recipes"."modifier_option_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_exactly_one_owner" CHECK ((
        (CASE WHEN "recipes"."product_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "recipes"."variant_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "recipes"."modifier_option_id" IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1);