CREATE TABLE `message_unsubscribe` (
	`message_id` text PRIMARY KEY NOT NULL,
	`url` text,
	`one_click` integer DEFAULT false NOT NULL,
	`mailto` text,
	`dkim_covers` integer DEFAULT false NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
