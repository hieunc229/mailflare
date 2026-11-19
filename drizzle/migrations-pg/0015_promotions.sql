CREATE TABLE "mailbox_promotion_settings" (
	"mailbox_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"backfill_status" text DEFAULT 'idle' NOT NULL,
	"backfill_cursor" text,
	"backfill_scanned" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_sender_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"sender_address" text NOT NULL,
	"category_override" text,
	"unsubscribed_at" bigint,
	"updated_by_user_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_address" text;--> statement-breakpoint
ALTER TABLE "mailbox_promotion_settings" ADD CONSTRAINT "mailbox_promotion_settings_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sender_preferences" ADD CONSTRAINT "mailbox_sender_preferences_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sender_preferences" ADD CONSTRAINT "mailbox_sender_preferences_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_promotion_settings_backfill_idx" ON "mailbox_promotion_settings" USING btree ("backfill_status");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_sender_preferences_mailbox_sender_idx" ON "mailbox_sender_preferences" USING btree ("mailbox_id","sender_address");--> statement-breakpoint
CREATE INDEX "mailbox_sender_preferences_updated_by_idx" ON "mailbox_sender_preferences" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE INDEX "messages_category_page_idx" ON "messages" USING btree ("mailbox_id","category","status","folder_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "messages_category_count_idx" ON "messages" USING btree ("mailbox_id","category","folder_id","direction","status","read","snoozed_until");
