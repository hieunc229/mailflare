ALTER TABLE "conversation_notes" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_notes_message_idx" ON "conversation_notes" USING btree ("message_id");
