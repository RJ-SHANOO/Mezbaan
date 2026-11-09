CREATE INDEX "devices_token_hash_idx" ON "devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "devices_pairing_code_hash_idx" ON "devices" USING btree ("pairing_code_hash");