CREATE INDEX "goods_received_note_items_note_idx" ON "goods_received_note_items" USING btree ("goods_received_note_id");--> statement-breakpoint
CREATE INDEX "goods_received_notes_purchase_order_created_idx" ON "goods_received_notes" USING btree ("purchase_order_id","created_at");--> statement-breakpoint
CREATE INDEX "goods_received_notes_branch_created_idx" ON "goods_received_notes" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "order_item_food_costs_branch_created_idx" ON "order_item_food_costs" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_order_items_purchase_order_idx" ON "purchase_order_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_return_items_return_idx" ON "purchase_return_items" USING btree ("purchase_return_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_purchase_order_created_idx" ON "purchase_returns" USING btree ("purchase_order_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_location_item_created_idx" ON "stock_ledger" USING btree ("storage_location_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_branch_created_idx" ON "stock_ledger" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_invoice_items_invoice_idx" ON "supplier_invoice_items" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_purchase_order_idx" ON "supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "supplier_ledger_entries_supplier_created_idx" ON "supplier_ledger_entries" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE INDEX "wastage_entries_branch_created_idx" ON "wastage_entries" USING btree ("branch_id","created_at");