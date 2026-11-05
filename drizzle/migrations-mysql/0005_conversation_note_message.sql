ALTER TABLE `conversation_notes` ADD `message_id` varchar(191);
--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);
--> statement-breakpoint
ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE set null ON UPDATE no action;
