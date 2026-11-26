CREATE TABLE `mail_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`who_can_post` text DEFAULT 'anyone' NOT NULL,
	`reply_to` text DEFAULT 'sender' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_groups_address_idx` ON `mail_groups` (`domain_id`,`local_part`);
--> statement-breakpoint
CREATE INDEX `mail_groups_created_by_idx` ON `mail_groups` (`created_by_user_id`);
--> statement-breakpoint
CREATE TABLE `mail_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`mailbox_id` text,
	`email` text,
	`can_send_as` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `mail_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_group_members_group_user_idx` ON `mail_group_members` (`group_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_group_members_group_mailbox_idx` ON `mail_group_members` (`group_id`,`mailbox_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_group_members_group_email_idx` ON `mail_group_members` (`group_id`,`email`);
--> statement-breakpoint
CREATE INDEX `mail_group_members_user_idx` ON `mail_group_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mail_group_members_mailbox_idx` ON `mail_group_members` (`mailbox_id`);
--> statement-breakpoint
CREATE INDEX `mail_group_members_created_by_idx` ON `mail_group_members` (`created_by_user_id`);
