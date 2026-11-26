CREATE TABLE "mail_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"local_part" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"who_can_post" text DEFAULT 'anyone' NOT NULL,
	"reply_to" text DEFAULT 'sender' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_groups" ADD CONSTRAINT "mail_groups_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_groups" ADD CONSTRAINT "mail_groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_groups_address_idx" ON "mail_groups" USING btree ("domain_id","local_part");
--> statement-breakpoint
CREATE INDEX "mail_groups_created_by_idx" ON "mail_groups" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE TABLE "mail_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"mailbox_id" text,
	"email" text,
	"can_send_as" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_group_members_group_user_idx" ON "mail_group_members" USING btree ("group_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_group_members_group_mailbox_idx" ON "mail_group_members" USING btree ("group_id","mailbox_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_group_members_group_email_idx" ON "mail_group_members" USING btree ("group_id","email");
--> statement-breakpoint
CREATE INDEX "mail_group_members_user_idx" ON "mail_group_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "mail_group_members_mailbox_idx" ON "mail_group_members" USING btree ("mailbox_id");
--> statement-breakpoint
CREATE INDEX "mail_group_members_created_by_idx" ON "mail_group_members" USING btree ("created_by_user_id");
--> statement-breakpoint
ALTER TABLE "mail_group_members" ADD CONSTRAINT "mail_group_members_group_id_mail_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mail_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_group_members" ADD CONSTRAINT "mail_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_group_members" ADD CONSTRAINT "mail_group_members_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_group_members" ADD CONSTRAINT "mail_group_members_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
