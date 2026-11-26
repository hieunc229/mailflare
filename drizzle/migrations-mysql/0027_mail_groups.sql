CREATE TABLE `mail_groups` (
	`id` varchar(191) NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`local_part` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`description` longtext,
	`who_can_post` varchar(64) NOT NULL DEFAULT 'anyone',
	`reply_to` varchar(64) NOT NULL DEFAULT 'sender',
	`disabled` boolean NOT NULL DEFAULT false,
	`created_by_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `mail_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_groups_address_idx` UNIQUE(`domain_id`,`local_part`)
);
--> statement-breakpoint
ALTER TABLE `mail_groups` ADD CONSTRAINT `mail_groups_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mail_groups` ADD CONSTRAINT `mail_groups_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `mail_groups_created_by_idx` ON `mail_groups` (`created_by_user_id`);
--> statement-breakpoint
CREATE TABLE `mail_group_members` (
	`id` varchar(191) NOT NULL,
	`group_id` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`user_id` varchar(191),
	`mailbox_id` varchar(191),
	`email` varchar(320),
	`can_send_as` boolean NOT NULL DEFAULT false,
	`created_by_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	CONSTRAINT `mail_group_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `mail_group_members_group_user_idx` UNIQUE(`group_id`,`user_id`),
	CONSTRAINT `mail_group_members_group_mailbox_idx` UNIQUE(`group_id`,`mailbox_id`),
	CONSTRAINT `mail_group_members_group_email_idx` UNIQUE(`group_id`,`email`)
);
--> statement-breakpoint
CREATE INDEX `mail_group_members_user_idx` ON `mail_group_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mail_group_members_mailbox_idx` ON `mail_group_members` (`mailbox_id`);
--> statement-breakpoint
CREATE INDEX `mail_group_members_created_by_idx` ON `mail_group_members` (`created_by_user_id`);
--> statement-breakpoint
ALTER TABLE `mail_group_members` ADD CONSTRAINT `mail_group_members_group_id_mail_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `mail_groups`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mail_group_members` ADD CONSTRAINT `mail_group_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mail_group_members` ADD CONSTRAINT `mail_group_members_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mail_group_members` ADD CONSTRAINT `mail_group_members_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
