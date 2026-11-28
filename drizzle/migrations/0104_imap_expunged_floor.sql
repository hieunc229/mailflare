ALTER TABLE `imap_folder_state` ADD `expunged_floor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `imap_expunged_created_idx` ON `imap_expunged` (`created_at`,`mailbox_id`,`folder_key`,`modseq`);
