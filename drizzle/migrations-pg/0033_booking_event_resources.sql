ALTER TABLE "booking_events" ADD COLUMN "resource_ids" text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "calendar_resources" ADD COLUMN "public_booking" boolean DEFAULT false NOT NULL;
