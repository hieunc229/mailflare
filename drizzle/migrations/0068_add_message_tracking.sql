CREATE TABLE `message_tracking` (
	`token` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`open_count` integer DEFAULT 0 NOT NULL,
	`first_opened_at` integer,
	`last_opened_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_tracking_message_idx` ON `message_tracking` (`message_id`);
--> statement-breakpoint
CREATE TABLE `message_opens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`opened_at` integer NOT NULL,
	`client` text,
	`device` text,
	`country` text,
	`city` text,
	`automated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`token`) REFERENCES `message_tracking`(`token`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_opens_token_idx` ON `message_opens` (`token`,`opened_at`);
