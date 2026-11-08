CREATE TABLE `conversation_notes` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`thread_key` varchar(512) NOT NULL,
	`message_id` varchar(191),
	`html` longtext NOT NULL,
	`author_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `conversation_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_author_user_id_users_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversation_notes_author_idx` ON `conversation_notes` (`author_user_id`);
