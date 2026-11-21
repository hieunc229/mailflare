ALTER TABLE `mailbox_aliases` ADD `label` text;
--> statement-breakpoint
ALTER TABLE `mailbox_aliases` ADD `enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `mailbox_aliases` ADD `masked` integer DEFAULT false NOT NULL;