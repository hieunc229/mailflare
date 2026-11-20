CREATE TABLE `contact_details` (
	`contact_id` text PRIMARY KEY NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
