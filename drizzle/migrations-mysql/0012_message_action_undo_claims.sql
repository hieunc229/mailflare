CREATE TABLE `message_action_undo_claims` (
	`nonce` varchar(191) NOT NULL,
	`user_id` longtext NOT NULL,
	`expires_at` bigint NOT NULL,
	CONSTRAINT `message_action_undo_claims_nonce` PRIMARY KEY(`nonce`)
);
--> statement-breakpoint
CREATE INDEX `message_action_undo_claims_expires_idx` ON `message_action_undo_claims` (`expires_at`);
