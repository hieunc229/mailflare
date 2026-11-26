CREATE TABLE `external_accounts` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`protocol` varchar(64) NOT NULL,
	`host` varchar(191) NOT NULL,
	`port` bigint NOT NULL,
	`tls_mode` varchar(64) NOT NULL DEFAULT 'implicit-tls',
	`username` varchar(191) NOT NULL,
	`password_encrypted` longtext NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`last_synced_at` bigint,
	`last_error` longtext,
	`sync_cursor` longtext,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `external_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `external_accounts_mailbox_host_user_idx` UNIQUE(`mailbox_id`,`host`,`username`)
);
--> statement-breakpoint
ALTER TABLE `external_accounts` ADD CONSTRAINT `external_accounts_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `external_accounts` ADD CONSTRAINT `external_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `external_accounts_poll_idx` ON `external_accounts` (`enabled`,`last_synced_at`);
--> statement-breakpoint
CREATE INDEX `external_accounts_user_idx` ON `external_accounts` (`user_id`);
