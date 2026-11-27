ALTER TABLE "calendar_resources" ADD COLUMN "booking_token" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "calendar_resource_bookings" ADD COLUMN "conflict_at" bigint;
