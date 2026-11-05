ALTER TABLE `conversation_notes` ADD `message_id` text REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);
