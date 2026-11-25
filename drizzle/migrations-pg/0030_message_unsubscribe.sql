CREATE TABLE "message_unsubscribe" (
	"message_id" text PRIMARY KEY NOT NULL,
	"url" text,
	"one_click" boolean DEFAULT false NOT NULL,
	"mailto" text,
	"dkim_covers" boolean DEFAULT false NOT NULL,
	"checked_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_unsubscribe" ADD CONSTRAINT "message_unsubscribe_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
