ALTER TABLE "mailboxes" ADD COLUMN "auto_reply_start_at" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "auto_reply_end_at" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "auto_reply_activated_at" bigint;
