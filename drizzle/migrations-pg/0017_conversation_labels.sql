CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#2563eb' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"label_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_mailbox_name_idx" ON "labels" USING btree ("mailbox_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_labels_label_thread_idx" ON "conversation_labels" USING btree ("label_id","thread_key");--> statement-breakpoint
CREATE INDEX "conversation_labels_mailbox_thread_idx" ON "conversation_labels" USING btree ("mailbox_id","thread_key");
