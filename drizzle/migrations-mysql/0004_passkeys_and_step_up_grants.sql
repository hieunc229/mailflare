ALTER TABLE `users` ADD `require_second_factor` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `passkey_count` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `security_version` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `users` SET `require_second_factor` = `totp_enabled`;--> statement-breakpoint
CREATE TABLE `passkey_credentials` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`credential_id` longtext NOT NULL,
	`credential_hash` varchar(191) NOT NULL,
	`public_key` longtext NOT NULL,
	`counter` bigint DEFAULT 0 NOT NULL,
	`transports` longtext,
	`device_type` longtext NOT NULL,
	`backed_up` boolean DEFAULT false NOT NULL,
	`aaguid` longtext,
	`name` longtext NOT NULL,
	`last_used_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `passkey_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `passkey_credentials_credential_hash_unique` UNIQUE(`credential_hash`)
);
--> statement-breakpoint
CREATE INDEX `passkey_credentials_user_idx` ON `passkey_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` varchar(191) NOT NULL,
	`ceremony_hash` varchar(191) NOT NULL,
	`challenge` longtext NOT NULL,
	`purpose` varchar(64) NOT NULL,
	`user_id` varchar(191),
	`binding_hash` longtext NOT NULL,
	`expires_at` bigint NOT NULL,
	`used_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `webauthn_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `webauthn_challenges_ceremony_hash_unique` UNIQUE(`ceremony_hash`)
);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_user_idx` ON `webauthn_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `passkey_enrollment_grants` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`created_by_user_id` varchar(191),
	`expires_at` bigint NOT NULL,
	`used_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `passkey_enrollment_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `passkey_enrollment_grants_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `passkey_enrollment_grants_user_idx` ON `passkey_enrollment_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_step_ups` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`session_hash` varchar(191) NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`purpose` varchar(64) NOT NULL,
	`target_user_id` varchar(191),
	`security_version` bigint DEFAULT 0 NOT NULL,
	`actor_security_version` bigint DEFAULT 0 NOT NULL,
	`expires_at` bigint NOT NULL,
	`used_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `auth_step_ups_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_step_ups_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `auth_step_ups_user_idx` ON `auth_step_ups` (`user_id`);--> statement-breakpoint
ALTER TABLE `passkey_credentials` ADD CONSTRAINT `passkey_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD CONSTRAINT `webauthn_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `passkey_enrollment_grants` ADD CONSTRAINT `passkey_enrollment_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `passkey_enrollment_grants` ADD CONSTRAINT `passkey_enrollment_grants_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_step_ups` ADD CONSTRAINT `auth_step_ups_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER `passkey_credentials_count_insert` AFTER INSERT ON `passkey_credentials` FOR EACH ROW
BEGIN
	UPDATE `users` SET `passkey_count` = `passkey_count` + 1 WHERE `id` = NEW.`user_id`;
END;--> statement-breakpoint
CREATE TRIGGER `passkey_credentials_count_delete` AFTER DELETE ON `passkey_credentials` FOR EACH ROW
BEGIN
	UPDATE `users` SET `passkey_count` = `passkey_count` - 1 WHERE `id` = OLD.`user_id`;
	UPDATE `users` SET `require_second_factor` = 0
	WHERE `id` = OLD.`user_id`
		AND `passkey_count` = 0
		AND `totp_enabled` = 0
		AND `deleted_at` IS NULL;
	IF (SELECT `passkey_count` FROM `users` WHERE `id` = OLD.`user_id`) = 0
		AND (SELECT `deleted_at` FROM `users` WHERE `id` = OLD.`user_id`) IS NULL
		AND (SELECT `password_hash` FROM `users` WHERE `id` = OLD.`user_id`) = '!passkey-only' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last-auth-method';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `users_last_password_update` BEFORE UPDATE ON `users` FOR EACH ROW
BEGIN
	IF NEW.`password_hash` <> OLD.`password_hash`
		AND NEW.`password_hash` = '!passkey-only'
		AND NEW.`passkey_count` = 0 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'last-auth-method';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `users_require_second_factor_update` BEFORE UPDATE ON `users` FOR EACH ROW
BEGIN
	IF OLD.`require_second_factor` = 0
		AND NEW.`require_second_factor` = 1
		AND NEW.`passkey_count` = 0
		AND NEW.`totp_enabled` = 0
		AND NEW.`deleted_at` IS NULL THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'second-factor-unavailable';
	END IF;
END;
