ALTER TABLE "api_keys" ADD COLUMN "last_used_protocol" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_ip" text;
