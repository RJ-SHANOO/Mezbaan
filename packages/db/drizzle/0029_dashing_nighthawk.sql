DROP INDEX "invoices_order_id_idx";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;