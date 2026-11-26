CREATE TABLE "external_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"user_id" text NOT NULL,
	"protocol" text NOT NULL,
	"host" text NOT NULL,
	"port" bigint NOT NULL,
	"tls_mode" text DEFAULT 'implicit-tls' NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" bigint,
	"last_error" text,
	"sync_cursor" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "external_accounts_mailbox_host_user_idx" ON "external_accounts" USING btree ("mailbox_id","host","username");
--> statement-breakpoint
CREATE INDEX "external_accounts_poll_idx" ON "external_accounts" USING btree ("enabled","last_synced_at");
--> statement-breakpoint
CREATE INDEX "external_accounts_user_idx" ON "external_accounts" USING btree ("user_id");
