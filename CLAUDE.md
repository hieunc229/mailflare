# CLAUDE.md

> **Schema or migration change? Update all three dialects (SQLite, PostgreSQL, MySQL).** See AGENTS.md "Database schema changes" and "Schema and migrations" in `docs/architecture.md`.

Detail for every area below: `docs/architecture.md` (section named in each bullet). User docs: `docs/*.md`.

## Commands

```bash
npm run dev                    # Vite + vinext in local workerd
npm run lint                   # vp lint (Oxlint, lint.config.ts)
npm run build                  # vinext build, including the complete Worker

npm run db:generate            # drizzle-kit generate (SQLite) from src/db/schema/index.ts
npm run db:generate:pg         # same schema, PostgreSQL -> drizzle/migrations-pg
npm run db:generate:mysql      # same schema, MySQL -> drizzle/migrations-mysql
npm run db:bundle              # package SQL for the Worker (src/lib/migrations/bundle*.json)
npm run db:smoke -- <DATABASE_URL> [driver]   # exercises migrations + query shapes on any database (MAILFLARE_DB_DIALECT must match)
npm run db:migrate:local       # wrangler d1 migrations apply DB --local
npm run db:migrate:remote      # --remote (needs a concrete database_id in wrangler.jsonc)
npm run db:seed                # POST /api/seed against localhost:3000

npm run deploy                 # vinext build + wrangler deploy; migrate later from Admin settings
npm run preview                # build and preview the vinext Worker locally
npm run cf-typegen             # regenerate cloudflare-env.d.ts from wrangler.jsonc
npm run build:node             # Node build: Next in Node mode + esbuild to dist/server.mjs (Dockerfile runs it)
npm run build:vercel           # Vercel build
node --test tests/*.test.mjs   # tests
```

- No `test` script in `package.json`. Tests are `node:test` files in `tests/`; pass the glob (Node 24 reads a bare `tests/` as a module path).
- Tests must not need Workers bindings. Anything reaching D1 or R2 goes in a `scripts/` script run against `npm run dev`.
- **The build does not type-check**: `next.config.ts` sets `typescript.ignoreBuildErrors: true`, `tsconfig.json` sets `noImplicitAny: false`. Run `npx tsc --noEmit` for real checks.
- `npm run deploy` builds with vinext and uploads with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to it, preserving the custom `worker.ts` entrypoint.

## Hard rules

- **Three DB dialects.** One schema (`src/db/schema/index.ts`), migrations in `drizzle/migrations/` (SQLite), `drizzle/migrations-pg/`, `drizzle/migrations-mysql/`. A schema change needs all three, plus the trigger/seed twin when it touches `messages`, `folders`, `mailboxes` or `mailbox_aliases`. `tests/database-dialects.test.mjs` fails on divergence or a stale bundle. Never edit an applied migration. `drizzle-kit generate` prompts interactively about a snapshot rename conflict for SQLite, so recent SQLite migrations are hand-written in the generated style.
- **Raw SQL works on all three.** No bare `0`/`1` as boolean, no `x = 0` on boolean columns, no `||` for strings on MySQL, quote reserved words via `sql.identifier`, no raw `ON CONFLICT ... DO UPDATE SET col = col + 1`. Helpers: `src/db/sql.ts`, `src/db/introspect.ts`, `src/lib/database-errors.ts`.
- **Backups.** A migration that creates, renames or removes a persisted table updates the backup lists in the same change (AGENTS.md "Database backup and restore"): `BACKUP_TABLES`, `INTERNAL_TABLES`, `LATER_MIGRATION_TABLES`, `BACKUP_TABLE_GROUPS`.
- **Optional tables/columns** (migration not applied yet): detect with `isMissingTableError` / `isMissingColumnError` (`src/lib/database-errors.ts`); drizzle wraps driver errors as "Failed query" with the message on `cause`, so matching `String(error)` misses it.
- **Bindings** only via `getEnv()` / `getEnvAsync()` (`src/lib/cloudflare.ts`) then `getDb(env)`. Never read `cloudflare:workers` env directly for storage. Branch on runtime with `isOffWorkers` / `isVercelRuntime` / `isNodeRuntime` (`src/lib/runtime.ts`).
- **Auth.** Prefer `requireSessionUser` (`src/lib/api/auth.ts`, returns 401) over `requireUser` (throws, becomes 500; many older routes still use it). Scope message queries by accessible mailbox ids, never `userId`.
- **Drafts are private**: gate every reader query with `draftsVisibleTo` / `isOthersDraft` (`src/lib/email/draft-access.ts`).
- **Rules need `scope`**: every `routing_rules` row sets `domain` or `mailbox` explicitly. Keep the reject / mailbox-alias / catch-all phase order.
- **TOTP**: every check goes through `verifySecondFactor`, never `matchTotpStep`.
- **Never write** `jmap_changes*`, `dav_changes` from application code (trigger-written, derived).
- `RealtimeHub` must stay exported from `worker.ts`. `CF_EMAIL_WORKER_NAME` (default `mailflare`), Worker `name` and `WORKER_SELF_REFERENCE` service in `wrangler.jsonc` must agree.
- Never commit `src/pages` (breaks `tsc`; the Vercel build writes it).
- Statements passed to `db.batch` come from the same `getDb(env)` instance. D1 binds at most 100 parameters per statement.
- `cloudflare-env.d.ts` is generated (500KB): `cf-typegen`, never hand-edit.
- New recurring jobs go in `src/lib/scheduled/jobs.ts`.
- Dangerous input (DMARC/TLS-RPT mail) is attacker-controlled: keep the caps and the verified-reporter rule in `report-parse.ts` / `ingest.ts`.

## Architecture

Next.js App Router on Cloudflare Workers via vinext. Drizzle over D1 (or PostgreSQL, MySQL, libSQL via `DATABASE_URL`), R2 for raw MIME, attachments and backups, Queues for mail, a Durable Object for realtime, cron for scheduled jobs. Also runs self-hosted (Node/Docker) and on Vercel.

One line per area; detail in `docs/architecture.md` under the quoted heading.

- **worker.ts is the entrypoint**: `fetch` (realtime WebSocket, `guardMtaStsHost`), `email` (Email Routing; `resolveIncomingMail` in `src/lib/email/incoming.ts`), `queue` (one consumer for inbound, outbound, agent), `scheduled`.
- **Mail pipeline**: inbound `processInboundMessage` (`src/lib/email/inbound.ts`); outbound `send.ts` / `sender.ts`; composer `rich-text-editor.tsx`; threading `resolveThreadId` (`threading.ts`). Use `splitEmailAddressList`, not `getEmailAddress`, for address lists.
- **Providers per domain**: `domains.sending_provider` / `receiving_provider` (`none|cloudflare|resend|ses`); `sendThroughProvider` (`outbound-provider.ts`), `intakeProviderMail` (`provider-intake.ts`), AWS client `src/lib/aws/`. One MX owner per domain (`MxConflictError`).
- **Suppression**: `src/lib/deliverability/`, `app_settings.suppression_mode` (`off|record|enforce`), `recordSuppression`, `findSuppressed`. User docs `docs/deliverability.md`.
- **DMARC / TLS-RPT / MTA-STS**: reserved `mailflare-reports@<domain>`, `ingestReportMail`, `report-parse.ts`. User docs `docs/dmarc-reports.md`, `docs/mta-sts.md`.
- **Routing rules**: two scopes, `resolveInboundAddress` (`src/lib/email/routing.ts`) and `resolveInboxRuleDestination`.
- **Webhooks**: `src/lib/email/webhooks.ts`, retries on `OUTBOUND_QUEUE`.
- **Cloudflare is live**: `src/lib/cloudflare-api.ts`, `src/lib/domains/`. Auth `CF_TOKEN` (preferred) or `CF_EMAIL` + `CF_API_KEY`.
- **Database**: `resolveDatabaseConfig` (`src/db/dialect.ts`), `withDatabase`, schema kit `src/db/schema/kits.ts`, drivers `src/db/drivers/*`, `compat.ts`. User docs `docs/databases.md`.
- **Migrations**: `npm run db:bundle`, runner `src/lib/migrations/service.ts`. Setup only initializes an empty database.
- **Storage**: `env.BUCKET` via `withStorage` (`src/lib/storage/index.ts`): R2, Backblaze B2 or AWS S3.
- **Vercel**: `MAILFLARE_RUNTIME=vercel`, `server/runtime/*vercel*`, user docs `docs/vercel.md`.
- **Node runtime**: `server/index.ts`, `server/runtime/env.ts`, `intakeIncomingMail` (`src/lib/email/intake.ts`).
- **JMAP**: `handleJmapRequest` (`src/lib/jmap/handler.ts`), change log `changes.ts`.
- **CalDAV/CardDAV**: `src/lib/dav/changes.ts`.
- **Mobile**: `POST /api/auth/device`, `sendNativePush` (`src/lib/push/native.ts`), relay `src/lib/push/relay.ts`.
- **Password reset / MFA**: `src/lib/auth/password-reset.ts`, `totp.ts`, `sendSystemEmail`.
- **Read receipts**: `GET /api/i/<token>.gif`, `classifyOpen`; undo send and `user_compose_preferences`.
- **Spam**: `analyzeSpam` (`src/lib/spam/engine.ts`), `SPAM_THRESHOLDS` (`weights.ts`).
- **Promotions**: `messages.category`, `detectBulkMail`, `categoryScopeCondition`. User docs `docs/promotions.md`.
- **Follow-ups / calendar reminders**: `runFollowUpReminders`, `runCalendarReminders` (five-minute cron).
- **Imports**: `import_jobs`, `processImportJob` (`src/lib/import/jobs.ts`). User docs `docs/import.md`.
- **Search**: FTS5 `messages_fts` (SQLite only), `buildSearchConditions` (`src/lib/search/conditions.ts`).
- **Access control**: `src/lib/mailboxes/access.ts`, `settings-access.ts`; session cookie `ep_session`, API keys `authenticateApiKey` + `requireScope`.
- **Folders**: `messages.status` is the folder; `folderId` for user folders.
- **Licensing**: Paymug (`src/lib/licenses/`), `getLicenseEntitlements` gates branding.
- **Self-update**: `deploy-update.yml` (`src/app/api/admin/update/utils.ts`).

## Conventions

- Tabs for indentation. `@/*` maps to `src/*`.
- Types and pure helpers go in sibling `*-types.d.ts` and `*-utils.ts` files; follow this for anything non-trivial.
- API routes return `NextResponse.json({ error: "..." }, { status })`; no shared error envelope helper.
- UI: Tailwind v4 + shadcn/Radix in `src/components/ui/`. `DialogContent` has no max height: add `max-h-[calc(100vh-4rem)] overflow-y-auto` to dialogs with more than a few fields.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
