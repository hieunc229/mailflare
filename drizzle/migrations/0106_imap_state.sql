CREATE TABLE `imap_mailbox_state` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`jmap_seq` integer NOT NULL,
	`modseq` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `imap_folder_state` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_key` text NOT NULL,
	`uidvalidity` integer NOT NULL,
	`uid_next` integer DEFAULT 1 NOT NULL,
	`highest_modseq` integer DEFAULT 0 NOT NULL,
	`initialized_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_folder_state_folder_idx` ON `imap_folder_state` (`mailbox_id`,`folder_key`);
--> statement-breakpoint
CREATE TABLE `imap_uids` (
	`mailbox_id` text NOT NULL,
	`folder_key` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text NOT NULL,
	`modseq` integer NOT NULL,
	`content_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_uids_uid_idx` ON `imap_uids` (`mailbox_id`,`folder_key`,`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_uids_message_idx` ON `imap_uids` (`mailbox_id`,`folder_key`,`message_id`);
--> statement-breakpoint
CREATE INDEX `imap_uids_message_id_idx` ON `imap_uids` (`message_id`);
--> statement-breakpoint
CREATE INDEX `imap_uids_modseq_idx` ON `imap_uids` (`mailbox_id`,`folder_key`,`modseq`);
--> statement-breakpoint
CREATE TABLE `imap_message_flags` (
	`message_id` text PRIMARY KEY NOT NULL,
	`answered` integer DEFAULT false NOT NULL,
	`forwarded` integer DEFAULT false NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `imap_expunged` (
	`mailbox_id` text NOT NULL,
	`folder_key` text NOT NULL,
	`uid` integer NOT NULL,
	`modseq` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_expunged_uid_idx` ON `imap_expunged` (`mailbox_id`,`folder_key`,`uid`);
--> statement-breakpoint
CREATE INDEX `imap_expunged_modseq_idx` ON `imap_expunged` (`mailbox_id`,`folder_key`,`modseq`);
--> statement-breakpoint
CREATE TABLE `imap_message_cache` (
	`message_id` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`synth_key` text,
	`envelope` text NOT NULL,
	`bodystructure` text NOT NULL,
	`header_size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
