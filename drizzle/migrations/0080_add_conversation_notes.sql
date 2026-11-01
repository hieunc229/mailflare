CREATE TABLE `conversation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_key` text NOT NULL,
	`html` text NOT NULL,
	`saved_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`);
--> statement-breakpoint
CREATE INDEX `conversation_notes_saved_by_idx` ON `conversation_notes` (`saved_by_user_id`);
