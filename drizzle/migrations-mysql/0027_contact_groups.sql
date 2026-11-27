CREATE TABLE `contact_groups` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `contact_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `contact_groups_user_name_idx` UNIQUE(`user_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `contact_group_members` (
	`id` varchar(191) NOT NULL,
	`group_id` varchar(191) NOT NULL,
	`contact_id` varchar(191) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `contact_group_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `contact_group_members_group_contact_idx` UNIQUE(`group_id`,`contact_id`)
);
--> statement-breakpoint
ALTER TABLE `contact_groups` ADD CONSTRAINT `contact_groups_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contact_group_members` ADD CONSTRAINT `contact_group_members_group_id_contact_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `contact_groups`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contact_group_members` ADD CONSTRAINT `contact_group_members_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `contact_groups_user_idx` ON `contact_groups` (`user_id`);--> statement-breakpoint
CREATE INDEX `contact_group_members_group_idx` ON `contact_group_members` (`group_id`);--> statement-breakpoint
CREATE INDEX `contact_group_members_contact_idx` ON `contact_group_members` (`contact_id`);
