CREATE TABLE `storage_objects` (
	`object_key` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`etag` text NOT NULL,
	`uploaded` integer NOT NULL,
	`http_metadata` text DEFAULT '{}' NOT NULL,
	`custom_metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_object_chunks` (
	`object_key` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`bytes` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`object_key`) REFERENCES `storage_objects`(`object_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_object_chunks_idx` ON `storage_object_chunks` (`object_key`,`chunk_index`);
