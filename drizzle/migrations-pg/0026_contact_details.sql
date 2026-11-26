CREATE TABLE "contact_details" (
	"contact_id" text PRIMARY KEY NOT NULL,
	"details" text DEFAULT '{}' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_details" ADD CONSTRAINT "contact_details_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
