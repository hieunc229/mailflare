CREATE TABLE "conversation_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"body" text NOT NULL,
	"saved_by_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_notes_mailbox_thread_idx" ON "conversation_notes" USING btree ("mailbox_id","thread_key");--> statement-breakpoint
CREATE INDEX "conversation_notes_saved_by_idx" ON "conversation_notes" USING btree ("saved_by_user_id");
