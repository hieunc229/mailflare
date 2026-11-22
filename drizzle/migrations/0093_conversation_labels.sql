CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#2563eb' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_mailbox_name_idx` ON `labels` (`mailbox_id`,`name`);
--> statement-breakpoint
CREATE TABLE `conversation_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`label_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_labels_label_thread_idx` ON `conversation_labels` (`label_id`,`thread_key`);
--> statement-breakpoint
CREATE INDEX `conversation_labels_mailbox_thread_idx` ON `conversation_labels` (`mailbox_id`,`thread_key`);
