ALTER TABLE "calendar_events" ADD COLUMN "response_status" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "invite_message_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "attendee_responses" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "invite_sender" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "invite_sequence" bigint;