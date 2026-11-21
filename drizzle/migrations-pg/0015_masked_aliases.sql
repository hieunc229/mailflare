ALTER TABLE "mailbox_aliases" ADD COLUMN "label" text;
--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD COLUMN "masked" boolean DEFAULT false NOT NULL;