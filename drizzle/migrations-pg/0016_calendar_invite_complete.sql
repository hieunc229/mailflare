CREATE TABLE "calendar_event_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"occurrence_ms" bigint NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"title" text,
	"description" text,
	"location" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_invite_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"invite_sequence" bigint DEFAULT 0 NOT NULL,
	"invite_sender" text DEFAULT '' NOT NULL,
	"cancelled_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_occurrence_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"occurrence_ms" bigint NOT NULL,
	"guest" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "repeat_interval" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "repeat_weekday" bigint;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "repeat_week" bigint;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "event_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_event_overrides" ADD CONSTRAINT "calendar_event_overrides_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_invite_tombstones" ADD CONSTRAINT "calendar_invite_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_occurrence_responses" ADD CONSTRAINT "calendar_occurrence_responses_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_overrides_event_occurrence_idx" ON "calendar_event_overrides" USING btree ("event_id","occurrence_ms");--> statement-breakpoint
CREATE INDEX "calendar_event_overrides_event_idx" ON "calendar_event_overrides" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "calendar_invite_tombstones_user_idx" ON "calendar_invite_tombstones" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_occurrence_responses_event_occurrence_guest_idx" ON "calendar_occurrence_responses" USING btree ("event_id","occurrence_ms","guest");--> statement-breakpoint
CREATE INDEX "calendar_occurrence_responses_event_idx" ON "calendar_occurrence_responses" USING btree ("event_id");
