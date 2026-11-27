ALTER TABLE "contacts" ADD COLUMN "dav_card_id" text;
--> statement-breakpoint
CREATE INDEX "contacts_dav_card_idx" ON "contacts" USING btree ("dav_card_id");
--> statement-breakpoint
ALTER TABLE "dav_collections" ADD COLUMN "seed_started_at" bigint;
--> statement-breakpoint
ALTER TABLE "dav_collections" ADD COLUMN "seed_cursor" text;
