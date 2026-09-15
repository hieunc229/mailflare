CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`token` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_user_token_idx` ON `device_tokens`(`user_id`, `token`);
--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens`(`user_id`);