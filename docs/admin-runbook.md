# Admin runbook

Operational checklist for self-hosted Mailflare. For initial installation and provider-specific steps, see [deployment](deployment.md), [self-hosting](self-hosting.md), [providers](providers.md), [databases](databases.md), [security](security.md), [troubleshooting](troubleshooting.md) and [API](api.md).

## Pre-flight

- [ ] Keep a tested copy of the database **and** object storage. Mailflare's JSON backup covers database records; it does not copy raw mail, attachments, Drive files or other bucket objects.
- [ ] Confirm the database and storage are reachable, have free capacity, and are included in your independent infrastructure backup.
- [ ] Confirm public HTTPS, DNS, MX and provider credentials are current. See [domain and provider setup](providers.md).
- [ ] On Workers, verify the deployed compatibility flags in `wrangler.jsonc`; for other Worker configuration, use the [deployment guide](deployment.md).
- [ ] Restrict runtime tokens and bucket/database credentials; do not put secrets in Git or command-line arguments.
- [ ] Record the deployed release/commit, database dialect, last successful backup, and a tested restore procedure.

## Routine operations

### Verify backups

- [ ] In **Admin → Backups**, run a manual backup after setup or before a risky change. Confirm its status is **completed**, then download it and retain an off-instance copy.
- [ ] Enable automatic backups and choose the schedule under **Admin → Backups**. The Worker cron checks the schedule at 02:00 UTC; schedule selection and retention are configured in the UI.
- [ ] Check the downloaded JSON backup has format `mailflare-database-backup` and version 1 or 2; keep the original file unchanged.
- [ ] Verify your separate storage-level backup includes the configured object bucket (R2, B2 or S3), or the full `/data` volume for the default Docker storage.
- [ ] Do not use `wrangler d1 export` for a database containing Mailflare's SQLite virtual search tables; use the app backup instead. See [database notes](databases.md).

### Restore drill and recovery

- [ ] Restore a recent backup into a disposable, empty Mailflare instance on a schedule. Validate account access, mail, calendar/Drive records, and that objects load from the corresponding object storage.
- [ ] Before a production restore, stop writes or put the service into maintenance; a restore replaces current database records and may sign users out.
- [ ] Before a recovery, enable every table group in **Admin → Backups**; manual exports honor excluded groups. Restore requires every group known to that backup format: version 1 backups predate the Drive group and validate only the groups then known, while version 2 backups with `includedTables` require every selected group. A partial-group version 2 backup is not a full recovery backup.
- [ ] For the app's JSON backup, sign in as the primary admin, open **Admin → Backups → Restore from backup**, select the file and confirm. Restore replaces records and is not atomic across the entire operation; maintain the maintenance window and preserve a pre-restore copy.
- [ ] The `backups` table in the JSON contains backup-history metadata, not the previous JSON backup files; preserve/download the actual backup file and separately preserve matching object storage.
- [ ] Keep the database schema migrated to at least the version that created the backup's tables. Restore handles older backup formats and known later-added columns, but does not create missing schema.
- [ ] Restore or preserve the matching object storage separately. Restoring database rows alone does not restore object contents. A database move between dialects uses the same backup/restore flow; see [databases](databases.md#what-is-the-same-everywhere).
- [ ] After recovery, verify admin login and representative mail bodies, attachments, Drive files, and scheduled jobs. Re-register push clients if needed; push registrations are intentionally not included in backups.

### Apply migrations and upgrade

- [ ] Take and download a full backup before upgrading. Review [deployment updates](deployment.md#updating-mailflare) and check release-specific notes.
- [ ] Deploy the new application first, then apply its database migrations promptly. On Workers, open **Admin settings** and use **Update database**; the Worker applies the dialect's migration bundle. For D1, `npm run db:migrate:remote` is the manual Wrangler recovery command after configuring the correct database ID in local `wrangler.jsonc`.
- [ ] For self-hosted Node/Docker, migrations run at startup before the server consumes mail. Check startup logs and do not direct traffic to a container that exited on a migration error.
- [ ] For source changes to schema, generate and bundle every dialect in this order:

  ```bash
  npm run db:generate
  npm run db:generate:pg
  npm run db:generate:mysql
  npm run db:bundle
  ```

  These produce SQL in `drizzle/migrations/`, `drizzle/migrations-pg/` and `drizzle/migrations-mysql/`; commit the migration files and refreshed bundles. Do not edit an applied migration. See [migration guidance](databases.md#migrations).
- [ ] Keep application code backward-compatible with the old schema until migrations finish. Avoid rolling code back across an applied, incompatible migration; restore a pre-upgrade database/backup if a rollback is necessary.
- [ ] For PostgreSQL and MySQL, use the app's migration runner (Admin settings / Node startup) for deployed instances. The Wrangler `db:migrate:remote` command applies only the D1/SQLite migration directory, not PostgreSQL or MySQL.

### Self-update on Cloudflare

- [ ] To automate upgrades, configure the GitHub token/repository settings and enable automatic updates in the admin update card; choose the release or commit channel there. The cron checks for updates, applies known pending migrations, and dispatches the update workflow once per target version. See [deployment: Updating Mailflare](deployment.md#updating-mailflare) for the exact permissions and variables.
- [ ] Before using **Update Mailflare**, save installation-specific changes separately if they need to be reapplied. A commit preserves a change in Git history (so it can be recovered), but the updater replaces the live tracked tree with upstream source; it does not preserve that change in the live tree. The update does not migrate the database or deploy by itself.
- [ ] Wait for the connected Cloudflare Git integration to finish deploying. Then open **Admin settings**, apply pending migrations, and verify the app and mail flows.
- [ ] For Docker, follow the image update and rollback procedure in [self-hosting](self-hosting.md#prebuilt-image-no-build). The in-app self-update button is disabled on Node.

## Incident recipes

### Inbound mail stopped

- [ ] Identify the receive path: Cloudflare Email Routing, Resend/SES, built-in SMTP, or the Cloudflare relay.
- [ ] Verify public DNS/MX, provider status and webhook/SNS delivery; in Mailflare, check the domain's receiving setup and mailbox routing rule.
- [ ] Check Worker or container logs for inbound queue, SMTP intake, webhook, and database errors. Confirm database migrations are current and the inbound queue is active.
- [ ] On Cloudflare, only missing-column/table failures use the five-minute inbound retry delay; other queue failures retry after about 10 seconds. The configured 12 is a retry cap, not a total-attempt count. Apply migrations promptly after deployment; see [deployment](deployment.md#updating-mailflare).
- [ ] For SMTP/DNS and provider checks, use [troubleshooting](troubleshooting.md) and [providers](providers.md).

### Outbound mail failing

- [ ] Check the selected sending provider on the sending domain and confirm credentials, verified sender/domain, region, and provider account status.
- [ ] For SES, verify production access; sandbox accounts can send only to verified recipients. For Cloudflare, check `CF_TOKEN` permissions and Email Sending setup. For a global SMTP relay, verify `SMTP_URL` and relay TLS/authentication.
- [ ] Inspect the failed message/job and service logs for the provider's response. Check outbound queue health on Workers.
- [ ] Follow [provider troubleshooting](troubleshooting.md) and [sending providers](providers.md).

### Scheduled work is not running

- [ ] On Workers, confirm both cron expressions in `wrangler.jsonc` are deployed: `0 2 * * *` (daily, UTC) and `*/5 * * * *` (every five minutes). Changes to triggers require deploying the complete Worker with `npm run deploy`.
- [ ] Confirm **Admin → Backups** has automatic backup enabled, and that the deployed Worker has its `DB` and `BUCKET` bindings.
- [ ] **Workers:** both cron ticks run agent maintenance, trash retention, follow-up/calendar reminders, promotion backfill, import-job sweeping, undo-claim pruning, and DAV change retention. Automatic update checks and migrations also run on each tick, but only when automatic updates are enabled. The 02:00 UTC tick additionally runs scheduled backups, account/auth/Drive/JMAP retention and purges, deliverability aggregation, and orphaned raw-mail cleanup.
- [ ] **Node/Docker:** the in-process scheduler ticks every minute; calendar reminders and other recurring checks run on those ticks, while promotion backfill is rate-limited to once per five minutes. Scheduled backups and daily maintenance run once per process per day, on its first scheduler tick during the 02:00 UTC hour. A sleeping/stopped container cannot run these jobs.
- [ ] `Scheduled backup failed` is a Node-only log message. On Workers, inspect `npx wrangler tail` and the backup history's recorded status/error instead; inspect container logs for Node scheduler errors.
- [ ] See [scheduled-backup troubleshooting](troubleshooting.md#scheduled-backups-are-not-running).

### Storage full or objects missing

- [ ] Check capacity and write/delete permissions for the active backend: Worker `BUCKET` (R2 by default), B2 when all four `B2_*` values are configured, or S3 when its bucket, region and credentials are configured. B2 takes precedence if both external backends are configured.
- [ ] Run `POST /api/v1/storage` with an admin API key carrying the `storage` scope; check `GET /api/v1/storage` for provider status. Each request writes/reads/deletes a small object or reports the active provider; see [object storage](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3).
- [ ] For Docker's default file storage, check free space and permissions on the mounted `DATA_DIR` (`/data` by default). Do not delete bucket objects to free space without confirming they are not referenced.
- [ ] A backend switch does not copy existing objects. Copy objects with the same keys before switching, or existing message bodies, attachments and Drive files will be missing. See [object storage](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3).

### License or branding problem

- [ ] For license activation/status, open **Admin → Licenses** and confirm the key and outbound access to Paymug; apply pending database migrations first. See [branding license](deployment.md#branding-license).
- [ ] For a missing branding icon, check active object-storage access and confirm the configured bucket data was not replaced or omitted during a backend change.
- [ ] Do not treat a license display issue as a mail or database failure; preserve the current database and logs before retrying activation.

## Monitoring and logs

- [ ] On Cloudflare, enable/retain Workers observability in the deployed configuration and inspect the Worker in Cloudflare's Logs/Observability view. Use `npx wrangler tail` from the configured project for live Worker logs.
- [ ] In Docker, inspect the service output with `docker compose logs -f mailflare`; include `--since=1h` when narrowing a recent incident. Logs go to the container's standard output/error; persist or forward them using your container platform.
- [ ] Alert on repeated failed backups, migration errors, inbound/outbound queue retries, storage test failures, HTTP 5xx spikes, and host/database/bucket capacity. Mailflare does not provide a separate built-in log archive or alerting service.
- [ ] Record UTC timestamps, release/commit, dialect, affected domain/mailbox, request or queue IDs where available, and sanitized error text. Never send tokens, passwords, message bodies, or raw backup files in an incident report.

## Escalation

- [ ] Gather sanitized logs and reproduction steps; note the hosting platform, Mailflare version/commit, database dialect, storage backend, mail provider and whether the failure began after a deploy, migration, credential rotation or backend switch.
- [ ] Preserve a database backup and relevant infrastructure snapshots before destructive repair. Do not post secrets or customer message content in an issue.
- [ ] Resolve Cloudflare, DNS, SES/Resend, SMTP, database-provider and storage-provider outages with that provider when Mailflare's logs show the failure is upstream. Use [troubleshooting](troubleshooting.md) first for known configuration errors.
