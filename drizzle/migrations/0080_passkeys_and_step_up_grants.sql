ALTER TABLE `users` ADD `require_second_factor` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `passkey_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `security_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `users` SET `require_second_factor` = `totp_enabled`;--> statement-breakpoint
CREATE TABLE `passkey_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`credential_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`aaguid` text,
	`name` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credentials_credential_hash_unique` ON `passkey_credentials` (`credential_hash`);--> statement-breakpoint
CREATE INDEX `passkey_credentials_user_idx` ON `passkey_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`ceremony_hash` text NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`binding_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_ceremony_hash_unique` ON `webauthn_challenges` (`ceremony_hash`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_user_idx` ON `webauthn_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `passkey_enrollment_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_enrollment_grants_token_hash_unique` ON `passkey_enrollment_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `passkey_enrollment_grants_user_idx` ON `passkey_enrollment_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_step_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`token_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`target_user_id` text,
	`security_version` integer DEFAULT 0 NOT NULL,
	`actor_security_version` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_step_ups_token_hash_unique` ON `auth_step_ups` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_step_ups_user_idx` ON `auth_step_ups` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER `passkey_credentials_count_insert` AFTER INSERT ON `passkey_credentials`
BEGIN
	UPDATE `users` SET `passkey_count` = `passkey_count` + 1 WHERE `id` = NEW.`user_id`;
END;--> statement-breakpoint
CREATE TRIGGER `passkey_credentials_count_delete` AFTER DELETE ON `passkey_credentials`
BEGIN
	UPDATE `users` SET `passkey_count` = `passkey_count` - 1 WHERE `id` = OLD.`user_id`;
	UPDATE `users` SET `require_second_factor` = 0
	WHERE `id` = OLD.`user_id`
		AND `passkey_count` = 0
		AND `totp_enabled` = 0
		AND `deleted_at` IS NULL;
	SELECT RAISE(ABORT, 'last-auth-method')
	WHERE (SELECT `passkey_count` FROM `users` WHERE `id` = OLD.`user_id`) = 0
		AND (SELECT `deleted_at` FROM `users` WHERE `id` = OLD.`user_id`) IS NULL
		AND (SELECT `password_hash` FROM `users` WHERE `id` = OLD.`user_id`) = '!passkey-only';
END;--> statement-breakpoint
CREATE TRIGGER `users_last_password_update` BEFORE UPDATE OF `password_hash` ON `users`
WHEN NEW.`password_hash` = '!passkey-only' AND NEW.`passkey_count` = 0
BEGIN
	SELECT RAISE(ABORT, 'last-auth-method');
END;--> statement-breakpoint
CREATE TRIGGER `users_require_second_factor_update` BEFORE UPDATE OF `require_second_factor` ON `users`
WHEN NEW.`require_second_factor` = 1 AND NEW.`passkey_count` = 0 AND NEW.`totp_enabled` = 0 AND NEW.`deleted_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'second-factor-unavailable');
END;
