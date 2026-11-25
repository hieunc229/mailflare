CREATE TABLE `message_unsubscribe` (
	`message_id` varchar(191) NOT NULL,
	`url` longtext,
	`one_click` boolean NOT NULL DEFAULT false,
	`mailto` longtext,
	`dkim_covers` boolean NOT NULL DEFAULT false,
	`checked_at` bigint NOT NULL,
	CONSTRAINT `message_unsubscribe_message_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
ALTER TABLE `message_unsubscribe` ADD CONSTRAINT `message_unsubscribe_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;
