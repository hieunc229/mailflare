CREATE TABLE "storage_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"etag" text NOT NULL,
	"uploaded" bigint NOT NULL,
	"http_metadata" text DEFAULT '{}' NOT NULL,
	"custom_metadata" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_object_chunks" (
	"object_key" text NOT NULL,
	"chunk_index" bigint NOT NULL,
	"bytes" bigint NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_object_chunks" ADD CONSTRAINT "storage_object_chunks_object_key_storage_objects_object_key_fk" FOREIGN KEY ("object_key") REFERENCES "public"."storage_objects"("object_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_object_chunks_idx" ON "storage_object_chunks" USING btree ("object_key","chunk_index");
