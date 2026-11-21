ALTER TABLE "app_settings" ADD COLUMN "auto_update" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "auto_update_dispatched_version" text;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "auto_update_channel" varchar(16) NOT NULL DEFAULT 'release';
