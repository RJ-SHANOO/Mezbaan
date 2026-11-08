ALTER TABLE "branches" ADD COLUMN "branch_number" integer;--> statement-breakpoint
UPDATE "branches" SET "branch_number" = sub.rn FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY restaurant_id ORDER BY created_at) AS rn FROM "branches"
) sub WHERE "branches".id = sub.id;--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "branch_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "terminal_number" integer;--> statement-breakpoint
UPDATE "devices" SET "terminal_number" = sub.rn FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY created_at) AS rn FROM "devices"
) sub WHERE "devices".id = sub.id;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "terminal_number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_restaurant_branch_number_idx" ON "branches" USING btree ("restaurant_id","branch_number");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_branch_terminal_number_idx" ON "devices" USING btree ("branch_id","terminal_number");--> statement-breakpoint
-- P1-28: branch_number/terminal_number are assigned automatically on INSERT
-- whenever the caller doesn't supply one, so every insert path (the real services,
-- and every test fixture that inserts a row directly) gets a correct, sequential,
-- collision-safe number without having to duplicate this logic app-side. The
-- UNIQUE indexes above are still the real guarantee against a genuine concurrent-
-- insert race (MAX+1 read here has the same tiny race window any app-level
-- equivalent would) — this trigger only has to get it right in the common case.
CREATE OR REPLACE FUNCTION assign_branch_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.branch_number IS NULL THEN
    SELECT COALESCE(MAX(branch_number), 0) + 1 INTO NEW.branch_number FROM branches WHERE restaurant_id = NEW.restaurant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER branches_assign_branch_number BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION assign_branch_number();--> statement-breakpoint
CREATE OR REPLACE FUNCTION assign_terminal_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.terminal_number IS NULL THEN
    SELECT COALESCE(MAX(terminal_number), 0) + 1 INTO NEW.terminal_number FROM devices WHERE branch_id = NEW.branch_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER devices_assign_terminal_number BEFORE INSERT ON devices FOR EACH ROW EXECUTE FUNCTION assign_terminal_number();
