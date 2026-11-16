CREATE TABLE "invoice_reconciliation_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"stored_subtotal_minor" bigint NOT NULL,
	"expected_subtotal_minor" bigint NOT NULL,
	"stored_service_charge_minor" bigint NOT NULL,
	"expected_service_charge_minor" bigint NOT NULL,
	"stored_tax_minor" bigint NOT NULL,
	"expected_tax_minor" bigint NOT NULL,
	"stored_total_minor" bigint NOT NULL,
	"expected_total_minor" bigint NOT NULL,
	"mismatched_fields" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_reconciliation_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bill_discount_applied_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoice_reconciliation_flags" ADD CONSTRAINT "invoice_reconciliation_flags_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reconciliation_flags" ADD CONSTRAINT "invoice_reconciliation_flags_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reconciliation_flags" ADD CONSTRAINT "invoice_reconciliation_flags_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reconciliation_flags" ADD CONSTRAINT "invoice_reconciliation_flags_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_reconciliation_flags_restaurant_created_idx" ON "invoice_reconciliation_flags" USING btree ("restaurant_id","created_at");--> statement-breakpoint
CREATE POLICY "invoice_reconciliation_flags_tenant_isolation" ON "invoice_reconciliation_flags" AS PERMISSIVE FOR ALL TO public USING (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true') WITH CHECK (restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true');