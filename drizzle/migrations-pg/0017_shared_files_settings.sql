ALTER TABLE "app_settings" ADD COLUMN "shared_files_notice_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "shared_files_notice_text" text;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "shared_files_link_days" integer NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "shared_files_notice_locale" text;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "shared_files_card_style" text NOT NULL DEFAULT 'card';