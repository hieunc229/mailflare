ALTER TABLE "imap_folder_state" ADD COLUMN "expunged_floor" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "imap_expunged_created_idx" ON "imap_expunged" USING btree ("created_at","mailbox_id","folder_key","modseq");
