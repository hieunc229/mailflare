CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`spec` text NOT NULL,
	`cursor` text DEFAULT '{}' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_jobs_user_idx` ON `import_jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_jobs_status_idx` ON `import_jobs` (`status`,`updated_at`);
