CREATE TABLE "booking_confirmation_templates" (
	"event_id" text PRIMARY KEY NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_confirmation_templates" ADD CONSTRAINT "booking_confirmation_templates_event_id_booking_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."booking_events"("id") ON DELETE cascade ON UPDATE no action;
