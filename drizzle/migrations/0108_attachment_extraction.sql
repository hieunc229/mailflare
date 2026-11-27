ALTER TABLE `message_attachments` ADD `extracted_text` text;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `extract_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `extracted_at` integer;
