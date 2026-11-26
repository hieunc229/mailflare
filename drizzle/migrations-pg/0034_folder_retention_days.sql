-- Optional per-folder retention. A non-NULL "retention_days" is the opt-in that lets
-- the scheduled purge delete aged mail in that folder whatever its status (so a
-- Newsletters folder can expire on its own schedule); NULL keeps the folder on the
-- owner's Trash/Spam retention only. Folder rules age mail by "created_at", the
-- message date; Trash/Spam retention keeps using "trashed_at".
ALTER TABLE "folders" ADD COLUMN "retention_days" bigint;
