CREATE TABLE `conversation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_key` text NOT NULL,
	`message_id` text,
	`html` text NOT NULL,
	`author_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`,`created_at`);
--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);
--> statement-breakpoint
CREATE INDEX `conversation_notes_author_idx` ON `conversation_notes` (`author_user_id`);
