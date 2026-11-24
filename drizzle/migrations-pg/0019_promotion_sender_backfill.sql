ALTER TABLE "mailbox_promotion_settings" ADD COLUMN "backfill_stalls" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_promotion_settings" ADD COLUMN "backfill_error" text;--> statement-breakpoint
ALTER TABLE "mailbox_promotion_settings" ADD COLUMN "backfill_day" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_promotion_settings" ADD COLUMN "backfill_day_rows" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("mailbox_id","sender_address","created_at");
