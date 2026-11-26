CREATE TABLE `external_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`protocol` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`tls_mode` text DEFAULT 'implicit-tls' NOT NULL,
	`username` text NOT NULL,
	`password_encrypted` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`sync_cursor` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_accounts_mailbox_host_user_idx` ON `external_accounts` (`mailbox_id`,`host`,`username`);
--> statement-breakpoint
CREATE INDEX `external_accounts_poll_idx` ON `external_accounts` (`enabled`,`last_synced_at`);
--> statement-breakpoint
CREATE INDEX `external_accounts_user_idx` ON `external_accounts` (`user_id`);
