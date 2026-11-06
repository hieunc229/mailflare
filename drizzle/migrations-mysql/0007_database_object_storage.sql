CREATE TABLE `storage_objects` (
	`object_key` varchar(512) NOT NULL,
	`size` bigint NOT NULL,
	`etag` longtext NOT NULL,
	`uploaded` bigint NOT NULL,
	`http_metadata` longtext NOT NULL DEFAULT ('{}'),
	`custom_metadata` longtext NOT NULL DEFAULT ('{}'),
	CONSTRAINT `storage_objects_object_key` PRIMARY KEY(`object_key`)
);
--> statement-breakpoint
CREATE TABLE `storage_object_chunks` (
	`object_key` varchar(512) NOT NULL,
	`chunk_index` bigint NOT NULL,
	`bytes` bigint NOT NULL,
	`data` longtext NOT NULL,
	CONSTRAINT `storage_object_chunks_idx` UNIQUE(`object_key`,`chunk_index`)
);
--> statement-breakpoint
ALTER TABLE `storage_object_chunks` ADD CONSTRAINT `storage_object_chunks_object_key_storage_objects_object_key_fk` FOREIGN KEY (`object_key`) REFERENCES `storage_objects`(`object_key`) ON DELETE cascade ON UPDATE no action;
