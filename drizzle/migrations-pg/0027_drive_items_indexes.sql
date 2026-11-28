CREATE INDEX "drive_items_parent_idx" ON "drive_items" USING btree ("parent_id");
--> statement-breakpoint
CREATE INDEX "drive_items_r2_key_idx" ON "drive_items" USING btree ("r2_key");
