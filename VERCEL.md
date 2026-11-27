# Deploying Mailflare to Vercel — plan

Status: **implemented (experimental)**, 2026-11-27. User docs: [docs/vercel.md](docs/vercel.md). Not yet run on real Vercel, Vercel Queues, Turso, Neon, S3, QStash or Upstash.

## What was built, where it differs from the plan

| Plan | Built |
|---|---|
| mta-sts guard in `middleware.ts` | Host rewrite in `next.config.ts` (a Next proxy buffers request bodies and would also affect Docker) |
| DAV as a non-Next function | Pages Router route, written only during `npm run build:vercel` (`scripts/build-vercel.mjs` + `server/runtime/vercel-dav-page.ts`) |
| QStash or Vercel Queues | Vercel Queues; QStash when its variables are set |
| Hosted pub/sub optional | Polling only |
| Rate limiters over Upstash Redis | Counters in the database; Upstash when its variables are set |
| S3 or B2 storage | Also a private Vercel Blob store (`server/runtime/vercel-blob.ts`), on Vercel only; not tried against a real store |
| IMAP: encrypt or drop | Dropped on Vercel |
| "Deploy to Vercel" button | In [docs/vercel.md](docs/vercel.md); not tried |
| Pro required for five-minute cron | Hobby works: a delayed queue message every five minutes (QStash: schedule created by hand), daily cron fallback in `vercel.json` |

## Checked locally

Before Vercel Queues and the database counters were added: with fake S3, QStash and Upstash and a real PostgreSQL 17: setup, login, relay inbound (small and 5 MB), 6 MB attachment, 20 MB Drive upload, background import, cron routes, DAV, mta-sts guard. The same flows pass on the Cloudflare Worker (`wrangler dev`) and the Docker image. Browser uploads (bucket CORS) are not covered.

The sections below are the original plan.

## Starting point (before this work)

Mailflare already runs off Cloudflare in the self-hosted Node runtime (`server/index.ts`, `MAILFLARE_RUNTIME=node`, real Next 16 build into `.next-node`). Vercel builds that same Next app natively, so most of the app (routes, UI, Drizzle over `DATABASE_URL`, S3/B2 storage, Resend/SES providers) carries over. What does not carry over is everything `server/index.ts` does *outside* Next, because Vercel has no long-lived process:

| Piece | Cloudflare | Node (Docker) | Vercel |
|---|---|---|---|
| HTTP app | vinext Worker | Next in `server/index.ts` | Next functions (native) |
| Database | D1 | better-sqlite3 file / `DATABASE_URL` | `DATABASE_URL` only (Neon/Supabase Postgres, PlanetScale, Turso). No local file: FS is ephemeral |
| Blob storage | R2 binding | file bucket / S3 / B2 | S3 / B2 via `withStorage` (no file bucket) |
| Queues (inbound, outbound, agent, imports, webhook retries) | CF Queues | `InProcessQueue` | **Missing.** In-process queue dies with the function |
| Realtime | Durable Object WebSocket | `ws` hub | **Missing.** Vercel functions cannot hold WebSocket servers |
| Cron (5-min + 02:00 daily) | cron triggers | `setInterval` scheduler | Vercel Cron (Hobby: daily only; Pro: per-minute) |
| Rate limiters | CF rate-limit bindings | in-memory fixed window | **Broken.** Per-instance memory, trivially bypassed |
| Inbound mail | `email` handler | SMTP listener | No SMTP. Relay Worker (`deploy/cloudflare-email-relay` → `/api/inbound`) or Resend/SES inbound |
| Outbound mail | `send_email` binding | nodemailer / CF Sending REST | Resend, SES or CF Sending REST |
| CalDAV/CardDAV (`PROPFIND`, `REPORT`) | intercepted in `worker.ts` | intercepted in `server/index.ts` | **Needs work.** Next route handlers cannot express these methods |
| `mta-sts.*` host guard | `worker.ts` | `server/index.ts` | Next middleware |
| Migrations | admin endpoint | applied at start | admin endpoint / `/api/setup/prepare` (no start hook) |
| Self-update | `deploy-update.yml` push → CF Git deploy | — | same workflow, Vercel Git deploys the push |

## Plan

### Phase 1 — runtime shell (`MAILFLARE_RUNTIME=vercel`)
- New env builder, sibling of `server/runtime/env.ts`, with no SQLite/file fallbacks: refuse to boot without `DATABASE_URL` and S3/B2 config.
- Reuse the `cloudflare:workers` alias (`next.config.ts`) for this runtime; keep `distDir` default so Vercel finds `.next`.
- `isNodeRuntime(env)` checks: audit each (setup checks, self-update, domain provisioning) and decide per check.
- Move the `mta-sts.*` guard into `middleware.ts`.
- `vercel.json`: framework Next, `npm run db:bundle` in build, function `maxDuration` for heavy routes.

### Phase 2 — queues
- Abstract the producer side already used (`send`, `sendBatch`, `delaySeconds`, `metrics`).
- Backend: Upstash QStash (HTTP push with delay + retries) or Vercel Queues. Consumer = one signed route (`/api/internal/queue/[name]`) dispatching with the same discriminators as `worker.ts` (`isInboundQueueMessage`, `isWebhookRetryMessage`, `isImportJobMessage`).
- Keep existing idempotency (inbound skips stored `rawR2Key`, conditional writes on import jobs).
- IMAP import puts the password in the queue message: with an external queue it now sits in a third party's storage. Encrypt the payload or drop IMAP import on Vercel.

### Phase 3 — cron
- `vercel.json` crons → `/api/internal/cron/frequent` (every 5 min) and `/api/internal/cron/daily` (02:00 UTC), guarded by `CRON_SECRET`.
- Factor the job list out of `server/runtime/scheduler.ts` / `worker.ts scheduled()` into one shared function so the three runtimes cannot drift.
- Document: Hobby plan = daily only → follow-ups, calendar reminders, promotions backfill, import sweep degrade badly. Pro required.

### Phase 4 — realtime + rate limits
- Realtime: no WebSockets. Rely on the existing `use-message-polling.ts` path, or plug a hosted pub/sub (Ably, Pusher, Upstash) behind `notifyUsersOfNewMessage`. Polling first.
- Rate limiters (`LOGIN`, `DEVICE_LOGIN`, `DAV`, `AGENT`): implement the binding shape over Upstash Redis. Without it login brute-force protection is effectively off — must ship before anyone uses this.

### Phase 5 — request size + DAV
- Vercel caps function request bodies at ~4.5 MB. Affects attachment upload, Drive, imports (`/api/import/messages`), JMAP upload, backup restore. Needs presigned direct-to-S3 uploads, then a small "claim" request. Biggest code change in this plan.
- DAV: route `/dav/*` and `/.well-known/caldav|carddav` via `vercel.json` rewrites to a non-Next Vercel function calling `handleDavRequest` (plain Web `Request` → `Response`). Verify `PROPFIND`/`REPORT` reach it; otherwise DAV is unsupported on Vercel.

### Phase 6 — inbound mail + docs
- Inbound: document two paths — Cloudflare Email Routing + relay Worker → `/api/inbound`, or Resend/SES inbound (already built).
- `docs/vercel.md` (user-facing), add to `docs/deployment.md`, a "Deploy to Vercel" button with required env vars.
- Smoke script against a preview deployment (queue round-trip, cron, inbound webhook, large upload).

## Pros
- Familiar one-click deploy for Next users; big audience, good marketing.
- Preview deployments per PR, simple Git-based updates (self-update workflow works as-is).
- App code mostly reused: multi-dialect DB, S3/B2 storage and Resend/SES providers already exist.
- Forces cleanups that help every runtime: shared cron job list, queue abstraction, direct-to-storage uploads.

## Cons
- Five platform primitives to replace or bolt on (queue, realtime, cron granularity, rate limits, body size). Each new third-party dependency (Neon + S3 + QStash + Upstash + mail provider) is a signup and an outage surface for the user.
- Still needs Cloudflare (or Resend/SES) for inbound mail — no SMTP on Vercel. "Deploy to Vercel" is never fully Vercel.
- Realistically Pro-only ($20/mo+) because of cron frequency and function duration; Cloudflare's free/$5 tier is far cheaper for mail volume.
- DAV and large uploads may stay partial.
- A fourth runtime to keep working (Workers, Node, hosted multi-tenant, Vercel) with no test coverage for it; every new feature using a queue, cron or binding must remember it.
- Costs scale with invocations and egress (raw MIME, attachments), unpredictable for users.

## Recommendation

**Not now.** Cloudflare is the native fit (email handler, Queues, Durable Objects, D1, R2 in one bill), and Docker covers "I don't want Cloudflare". Vercel adds a fourth runtime with the most gaps of any, still depends on Cloudflare or Resend/SES for receiving, and needs Pro to work properly.

If demand is real (users asking, not guessing), do it in this order and stop at whatever is enough:
1. Phase 3's shared cron function and Phase 2's queue abstraction — useful for all runtimes anyway.
2. A minimal "Vercel + Neon + S3 + QStash + Upstash, inbound via Resend" tier with polling realtime, uploads ≤ 4.5 MB and no DAV, labelled experimental.
3. Direct-to-S3 uploads and DAV only if that tier gets used.

Rough effort: minimal tier ~1–2 weeks; full parity (uploads, DAV, hosted realtime) ~3–4 weeks.
