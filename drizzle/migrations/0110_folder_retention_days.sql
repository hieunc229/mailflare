-- Optional per-folder retention. A non-NULL `retention_days` is the opt-in that lets
-- the scheduled purge delete aged mail in that folder (so a Newsletters folder can expire
-- on its own schedule); NULL keeps the folder on the owner's Trash/Spam retention only.
-- A folder rule deletes `received` and `archived` messages that are not `direction = 'outbound'`, whose
-- `created_at` (the message date, not the import time) is older than the window. It never deletes
-- drafts, sent copies (a completed send filed here keeps `direction = 'outbound'`, and imported
-- Sent mail is stored that way), mail a live outbound job still owns, Trash/Spam (they follow the
-- owner's Trash rule) or any status outside that list. Trash/Spam retention keeps using `trashed_at`.
ALTER TABLE `folders` ADD `retention_days` integer;
