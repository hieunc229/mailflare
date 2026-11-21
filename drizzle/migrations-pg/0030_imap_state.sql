CREATE TABLE "imap_expunged" (
	"mailbox_id" text NOT NULL,
	"folder_key" text NOT NULL,
	"uid" bigint NOT NULL,
	"modseq" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_folder_state" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"folder_key" text NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"uid_next" bigint DEFAULT 1 NOT NULL,
	"highest_modseq" bigint DEFAULT 0 NOT NULL,
	"initialized_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_mailbox_state" (
	"mailbox_id" text PRIMARY KEY NOT NULL,
	"jmap_seq" bigint NOT NULL,
	"modseq" bigint DEFAULT 1 NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_message_cache" (
	"message_id" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"synth_key" text,
	"envelope" text NOT NULL,
	"bodystructure" text NOT NULL,
	"header_size" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_message_flags" (
	"message_id" text PRIMARY KEY NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"forwarded" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"keywords" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_uids" (
	"mailbox_id" text NOT NULL,
	"folder_key" text NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" text NOT NULL,
	"modseq" bigint NOT NULL,
	"content_hash" text
);
--> statement-breakpoint
ALTER TABLE "imap_folder_state" ADD CONSTRAINT "imap_folder_state_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "imap_mailbox_state" ADD CONSTRAINT "imap_mailbox_state_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "imap_message_cache" ADD CONSTRAINT "imap_message_cache_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "imap_message_flags" ADD CONSTRAINT "imap_message_flags_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "imap_expunged_uid_idx" ON "imap_expunged" USING btree ("mailbox_id","folder_key","uid");
--> statement-breakpoint
CREATE INDEX "imap_expunged_modseq_idx" ON "imap_expunged" USING btree ("mailbox_id","folder_key","modseq");
--> statement-breakpoint
CREATE UNIQUE INDEX "imap_folder_state_folder_idx" ON "imap_folder_state" USING btree ("mailbox_id","folder_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "imap_uids_uid_idx" ON "imap_uids" USING btree ("mailbox_id","folder_key","uid");
--> statement-breakpoint
CREATE UNIQUE INDEX "imap_uids_message_idx" ON "imap_uids" USING btree ("mailbox_id","folder_key","message_id");
--> statement-breakpoint
CREATE INDEX "imap_uids_message_id_idx" ON "imap_uids" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "imap_uids_modseq_idx" ON "imap_uids" USING btree ("mailbox_id","folder_key","modseq");
