ALTER TABLE "stock_ledger" ADD COLUMN "unit_cost_minor" bigint;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "average_cost_minor" bigint;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD COLUMN "currency" text;