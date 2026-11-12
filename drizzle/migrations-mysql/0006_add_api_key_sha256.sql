ALTER TABLE `api_keys` ADD `key_sha256` varchar(191);--> statement-breakpoint
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_key_sha256_idx` UNIQUE(`key_sha256`);
