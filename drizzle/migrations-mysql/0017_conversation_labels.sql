CREATE TABLE `labels` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`name` varchar(191) NOT NULL,
	`color` longtext NOT NULL DEFAULT ('#2563eb'),
	`created_at` bigint NOT NULL,
	CONSTRAINT `labels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_labels` (
	`id` varchar(191) NOT NULL,
	`label_id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`thread_key` varchar(512) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `conversation_labels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `labels` ADD CONSTRAINT `labels_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_labels` ADD CONSTRAINT `conversation_labels_label_id_labels_id_fk` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_labels` ADD CONSTRAINT `conversation_labels_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `labels_mailbox_name_idx` ON `labels` (`mailbox_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_labels_label_thread_idx` ON `conversation_labels` (`label_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `conversation_labels_mailbox_thread_idx` ON `conversation_labels` (`mailbox_id`,`thread_key`);
