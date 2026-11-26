ALTER TABLE `message_attachments` ADD `extracted_text` longtext;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `extract_status` varchar(191) NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `extracted_at` bigint;
