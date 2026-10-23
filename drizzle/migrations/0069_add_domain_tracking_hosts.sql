CREATE TABLE `domain_tracking_hosts` (
	`domain_id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_tracking_hosts_hostname_idx` ON `domain_tracking_hosts` (`hostname`);
