CREATE TABLE "contact_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_group_id_contact_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."contact_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_groups_user_name_idx" ON "contact_groups" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "contact_groups_user_idx" ON "contact_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_group_members_group_contact_idx" ON "contact_group_members" USING btree ("group_id","contact_id");--> statement-breakpoint
CREATE INDEX "contact_group_members_group_idx" ON "contact_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "contact_group_members_contact_idx" ON "contact_group_members" USING btree ("contact_id");
