CREATE TABLE `contact_details` (
	`contact_id` varchar(191) NOT NULL,
	`details` longtext NOT NULL DEFAULT ('{}'),
	`updated_at` bigint NOT NULL,
	CONSTRAINT `contact_details_contact_id` PRIMARY KEY(`contact_id`)
);
--> statement-breakpoint
ALTER TABLE `contact_details` ADD CONSTRAINT `contact_details_contact_id_contacts_id_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE cascade ON UPDATE no action;
