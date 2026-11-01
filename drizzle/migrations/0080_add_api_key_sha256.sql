-- SHA-256 of high-entropy API keys and app passwords. Null on keys that only have a bcrypt hash.
ALTER TABLE `api_keys` ADD `key_sha256` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_sha256_idx` ON `api_keys` (`key_sha256`);
