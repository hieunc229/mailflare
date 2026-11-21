CREATE TABLE `imap_expunged` (
	`mailbox_id` varchar(191) NOT NULL,
	`folder_key` varchar(191) NOT NULL,
	`uid` bigint NOT NULL,
	`modseq` bigint NOT NULL,
	`created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `imap_expunged_uid_idx` UNIQUE(`mailbox_id`,`folder_key`,`uid`)
);
--> statement-breakpoint
CREATE TABLE `imap_folder_state` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`folder_key` varchar(191) NOT NULL,
	`uidvalidity` bigint NOT NULL,
	`uid_next` bigint NOT NULL DEFAULT 1,
	`highest_modseq` bigint NOT NULL DEFAULT 0,
	`initialized_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `imap_folder_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `imap_folder_state_folder_idx` UNIQUE(`mailbox_id`,`folder_key`)
);
--> statement-breakpoint
CREATE TABLE `imap_mailbox_state` (
	`mailbox_id` varchar(191) NOT NULL,
	`jmap_seq` bigint NOT NULL,
	`modseq` bigint NOT NULL DEFAULT 1,
	`updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `imap_mailbox_state_mailbox_id` PRIMARY KEY(`mailbox_id`)
);
--> statement-breakpoint
CREATE TABLE `imap_message_cache` (
	`message_id` varchar(191) NOT NULL,
	`size` bigint NOT NULL,
	`synth_key` longtext,
	`envelope` longtext NOT NULL,
	`bodystructure` longtext NOT NULL,
	`header_size` bigint NOT NULL,
	`created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `imap_message_cache_message_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
CREATE TABLE `imap_message_flags` (
	`message_id` varchar(191) NOT NULL,
	`answered` boolean NOT NULL DEFAULT false,
	`forwarded` boolean NOT NULL DEFAULT false,
	`deleted` boolean NOT NULL DEFAULT false,
	`keywords` longtext NOT NULL DEFAULT ('[]'),
	`updated_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `imap_message_flags_message_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
CREATE TABLE `imap_uids` (
	`mailbox_id` varchar(191) NOT NULL,
	`folder_key` varchar(191) NOT NULL,
	`uid` bigint NOT NULL,
	`message_id` varchar(191) NOT NULL,
	`modseq` bigint NOT NULL,
	`content_hash` longtext,
	CONSTRAINT `imap_uids_uid_idx` UNIQUE(`mailbox_id`,`folder_key`,`uid`),
	CONSTRAINT `imap_uids_message_idx` UNIQUE(`mailbox_id`,`folder_key`,`message_id`)
);
--> statement-breakpoint
ALTER TABLE `imap_folder_state` ADD CONSTRAINT `imap_folder_state_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `imap_mailbox_state` ADD CONSTRAINT `imap_mailbox_state_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `imap_message_cache` ADD CONSTRAINT `imap_message_cache_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `imap_message_flags` ADD CONSTRAINT `imap_message_flags_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `imap_expunged_modseq_idx` ON `imap_expunged` (`mailbox_id`,`folder_key`,`modseq`);
--> statement-breakpoint
CREATE INDEX `imap_uids_message_id_idx` ON `imap_uids` (`message_id`);
--> statement-breakpoint
CREATE INDEX `imap_uids_modseq_idx` ON `imap_uids` (`mailbox_id`,`folder_key`,`modseq`);
