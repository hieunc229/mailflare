# Repository agent instructions

## Database schema changes: update every dialect

Mailflare runs on SQLite/D1, PostgreSQL and MySQL from one schema file. Any change to `src/db/schema/index.ts` (table, column, index, default) **must ship a migration for all three dialects in the same change**:

1. `npm run db:generate` → `drizzle/migrations/` (SQLite/D1)
2. `npm run db:generate:pg` → `drizzle/migrations-pg/` (PostgreSQL)
3. `npm run db:generate:mysql` → `drizzle/migrations-mysql/` (MySQL/MariaDB)
4. `npm run db:bundle` to refresh `src/lib/migrations/bundle*.json` (commit them).
5. Touching `messages`, `folders`, `mailboxes` or `mailbox_aliases` behaviour that SQLite does with triggers (JMAP change log, `trashed_at`, search index): add the equivalent trigger SQL to a new hand-written PostgreSQL and MySQL migration too.
6. Run `node --test tests/*.test.mjs` (`tests/database-dialects.test.mjs` fails if the dialects diverge or a bundle is stale) and, if a database is available, `npm run db:smoke -- <DATABASE_URL>`.

Raw SQL must also work on all three dialects; see "The database is D1 unless `DATABASE_URL` says otherwise" in `docs/architecture.md` and `docs/databases.md`. Never edit an already-applied migration; add a new one.

## Database backup and restore

- Whenever a migration creates, renames, or removes a persisted table, update the backup and restore table lists in the same change, even if the feature is unrelated to backups. Review `BACKUP_TABLES` and `INTERNAL_TABLES` in `src/lib/backups/export.ts`, `BACKUP_TABLE_GROUPS` in `src/lib/backups/table-groups.ts`, and `DatabaseBackupTable` in `src/lib/backups/types.d.ts`. Add a new table to `LATER_MIGRATION_TABLES` in `src/lib/backups/export.ts` too, so backups and restores keep working on installs that haven't applied its migration yet (otherwise export runs `SELECT *` on the missing table and the whole backup throws).
- Put every backed-up table in exactly one group. Keep `BACKUP_TABLES` in foreign-key dependency order so restore inserts parents before children and deletes them in reverse order. Exclude a table only when its contents are derived or internally managed, and document why.
- When adding a table, check backup and restore behavior both before and after its migration is applied. Keep older full backup documents restorable.
