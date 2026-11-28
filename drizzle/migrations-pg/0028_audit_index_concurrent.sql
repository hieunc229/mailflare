-- Built outside a transaction so audit_logs keeps taking writes. The drop clears an INVALID index left by an interrupted build.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_target_action_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_target_action_created_idx" ON "audit_logs" USING btree ("target_user_id","action","created_at");
--> statement-breakpoint
-- The replacement is built, so the old single-column index can go.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_target_user_idx";
