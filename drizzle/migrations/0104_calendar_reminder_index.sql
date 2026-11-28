CREATE INDEX IF NOT EXISTS `calendar_events_repeat_starts_idx` ON `calendar_events` (`repeat`,`starts_at`,`id`);
