-- Folder counts and conversation paging on large mailboxes. The counts
-- endpoint groups by (mailbox, folder, direction, status, read, starred,
-- snoozed_until); without a covering index that means a temp b-tree over
-- every row.
CREATE INDEX IF NOT EXISTS `messages_counts_cover_idx` ON `messages` (`mailbox_id`, `folder_id`, `direction`, `status`, `read`, `starred`, `snoozed_until`);--> statement-breakpoint
-- Conversation paging partitions by coalesce(thread_id, id) and orders each
-- partition by created_at desc. Column order matters: the thread key must
-- come before created_at so the index both covers the query and feeds the
-- window partition in sorted order. Without this, ANALYZE stats can steer
-- the planner onto the non-covering messages_mailbox_thread_key_idx and
-- pay a table lookup per scanned row.
CREATE INDEX IF NOT EXISTS `messages_conv_cover_idx` ON `messages` (`mailbox_id`, `status`, coalesce(`thread_id`, `id`), `created_at`, `id`, `snoozed_until`);
