-- Optional per-folder retention. A non-NULL "retention_days" is the opt-in that lets
-- the scheduled purge delete aged mail in that folder (so a Newsletters folder can expire
-- on its own schedule); NULL keeps the folder on the owner's Trash/Spam retention only.
-- A folder rule deletes "received" and "archived" messages whose "created_at" (the message date,
-- not the import time) is older than the window. It never deletes drafts, mail a live
-- outbound job still owns, "sent" mail, Trash/Spam (they follow the owner's Trash rule) or any
-- status outside that list. Trash/Spam retention keeps using "trashed_at".
ALTER TABLE "folders" ADD COLUMN "retention_days" bigint;
