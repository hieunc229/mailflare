CREATE TABLE "message_action_undo_claims" (
	"nonce" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_action_undo_claims_expires_idx" ON "message_action_undo_claims" USING btree ("expires_at");
