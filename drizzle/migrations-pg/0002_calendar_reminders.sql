ALTER TABLE "calendar_events" ADD COLUMN "reminder_minutes" bigint;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "last_reminded_start" bigint;