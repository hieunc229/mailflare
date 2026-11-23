CREATE TABLE `contact_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contact_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `contact_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_groups_user_name_idx` ON `contact_groups` (`user_id`,`name`);
--> statement-breakpoint
CREATE INDEX `contact_groups_user_idx` ON `contact_groups` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_group_members_group_contact_idx` ON `contact_group_members` (`group_id`,`contact_id`);
--> statement-breakpoint
CREATE INDEX `contact_group_members_group_idx` ON `contact_group_members` (`group_id`);
--> statement-breakpoint
CREATE INDEX `contact_group_members_contact_idx` ON `contact_group_members` (`contact_id`);
