ALTER TABLE "api_keys" ADD COLUMN "key_sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_sha256_idx" ON "api_keys" USING btree ("key_sha256");
