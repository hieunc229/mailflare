ALTER TABLE `drive_items` MODIFY `r2_key` varchar(512);
--> statement-breakpoint
CREATE INDEX `drive_items_parent_idx` ON `drive_items` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `drive_items_r2_key_idx` ON `drive_items` (`r2_key`);
