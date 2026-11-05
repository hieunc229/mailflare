CREATE TABLE `conversation_notes` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`thread_key` varchar(512) NOT NULL,
	`body` longtext NOT NULL,
	`saved_by_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	CONSTRAINT `conversation_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_saved_by_user_id_users_id_fk` FOREIGN KEY (`saved_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `conversation_notes_saved_by_idx` ON `conversation_notes` (`saved_by_user_id`);
--> statement-breakpoint
CREATE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`);
