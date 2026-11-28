CREATE INDEX "calendar_events_repeat_starts_idx" ON "calendar_events" USING btree ("repeat","starts_at","id");
