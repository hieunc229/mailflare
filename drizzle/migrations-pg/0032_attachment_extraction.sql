ALTER TABLE "message_attachments" ADD COLUMN "extracted_text" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "extract_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "extracted_at" bigint;
