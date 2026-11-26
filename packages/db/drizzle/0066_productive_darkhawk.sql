DROP INDEX "commission_entries_payment_idx";--> statement-breakpoint
ALTER TABLE "commission_entries" ALTER COLUMN "payment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD COLUMN "entry_type" text DEFAULT 'charge' NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_refund_idx" ON "commission_entries" USING btree ("refund_id") WHERE "commission_entries"."refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_payment_idx" ON "commission_entries" USING btree ("payment_id") WHERE "commission_entries"."payment_id" IS NOT NULL;