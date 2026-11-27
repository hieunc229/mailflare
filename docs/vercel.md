# Deploying Mailflare to Vercel

Cloudflare Workers (see [deployment](deployment.md)) and [Docker](self-hosting.md) are the recommended ways to run
Mailflare. Vercel works, with more services to set up and the [limits](#limits) below.

## What you need

| Service | Used for | Variables |
| --- | --- | --- |
| Vercel Hobby or Pro | The app, with 300 s functions, and its job queue ([Vercel Queues](https://vercel.com/docs/queues), beta). Hobby is for non-commercial use only. | |
| PostgreSQL, MySQL or Turso ([databases](databases.md)) | All records and rate limit counters | See [database](#database) |
| Vercel Blob (**private** store), AWS S3 or Backblaze B2 | Raw mail, attachments, Drive, backups | See [storage](#storage) |
| | Protects the cron routes | `CRON_SECRET`: a long random string |
| | Public address | `APP_URL=https://mail.example.com`; defaults to the project's production domain |

The app refuses to start and lists what is missing until the database, storage, `CRON_SECRET` and a public address
are set.

### Database

Either way works:

- **Connect it in Vercel.** Add Turso from the Vercel Marketplace and press **Connect Project**, keeping the default
  variable prefix. Vercel sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, and Mailflare reads them. Marketplace
  databases that set `DATABASE_URL` (such as Neon) work the same way.
- **Set it yourself.** `DATABASE_URL`, plus `DATABASE_AUTH_TOKEN` for Turso. When both are present, `DATABASE_URL`
  wins.

**Turn database branching off.** If the Turso connection has **Create database branch for deployment** enabled, each
deployment gets its own copy of the database, and anything saved in the previous deployment's branch (including
first setup) is missing from the next one. Leave it unchecked, at least for Production, when you connect the
project. To change an existing connection, disconnect the database from the project, connect it again without that
option, and redeploy. Records already saved in a branch are not copied back.

A PostgreSQL provider with an HTTP driver (Neon) or a connection pooler suits serverless functions best, because
each query otherwise opens its own connection. Turso is reached over HTTP.

**Keep the database near the functions.** Create it in the region your functions run in, or change the region under
Settings → Functions → Function Region (Vercel starts in Washington, D.C., `iad1`) and redeploy. A distant database
slows every page, and [first setup](#first-setup) most of all.

### Storage

Pick one:

- **Vercel Blob. The store must be private.** In the project's Storage tab, create a Blob store, choose **Private**
  access and connect it, keeping the default variable prefix. Mailflare writes private files only, so a public store
  does not work; if you made one, create a private store and connect that instead. Vercel sets `BLOB_STORE_ID` (or
  `BLOB_READ_WRITE_TOKEN`), and Mailflare reads either. No bucket CORS is needed. **Check the
  [Hobby limits](https://vercel.com/docs/vercel-blob/usage-and-pricing) first:** 1 GB, 10,000 simple and 2,000
  advanced operations a month. Every stored file is an advanced operation, and each incoming message stores several,
  so a few hundred messages can use up the month. Over a limit, Hobby loses access to Blob for 30 days, which stops
  mail.
- **AWS S3 or Backblaze B2.** `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, or the four
  `B2_*`. Then [allow browser uploads on the bucket](#bucket-cors).

An S3 or Backblaze bucket wins over a connected Blob store. Nothing moves files between stores, so changing storage
later leaves the existing ones behind.

### Optional: QStash and Upstash Redis

Nothing here is required. Set these only to replace the defaults:

- **[Upstash QStash](https://upstash.com/docs/qstash) instead of Vercel Queues:** `QSTASH_TOKEN`,
  `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` outside the default region). Then add
  the [QStash schedule](#with-qstash).
- **Upstash Redis instead of database counters for rate limits:** `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN` (the `KV_REST_API_*` names work too).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhieunc229%2Fmailflare&env=CRON_SECRET&envDescription=See%20docs%2Fvercel.md&envLink=https%3A%2F%2Fgithub.com%2Fhieunc229%2Fmailflare%2Fblob%2Fmain%2Fdocs%2Fvercel.md)

1. Import the repository and set the variables above. `vercel.json` sets the build command, the queue consumer and
   the daily cron jobs.
2. Add the [database](#database) and [storage](#storage), then redeploy so the app sees their variables.
3. With S3 or Backblaze, [allow browser uploads on the bucket](#bucket-cors).
4. Turn off Deployment Protection for the production domain: the five-minute schedule, cron and mail providers must
   reach it.
5. Open `/setup`, wait for the [first setup](#first-setup) to finish, then create the admin account and add your
   domain.
6. [Start the five-minute schedule](#five-minute-schedule).

Preview deployments need their own database, storage and `APP_URL`.

### First setup

The first visit to `/setup` creates the database tables. On Turso that is more than a hundred migrations, sent one
statement at a time over the network, so it can take several minutes, and the page shows **Checking installation**
meanwhile.

If it seems stuck:

1. Leave the page open for five minutes.
2. Reload it. On Turso and PostgreSQL each finished migration is saved, so setup continues where it stopped. Reload
   again if needed.
3. [Move the functions near the database](#database) and redeploy.
4. If it still does not finish, look for `/api/setup/prepare` in the project's Vercel logs.

### Five-minute schedule

Follow-up and calendar reminders, the import sweep, the promotions backfill, auto-update and other housekeeping are
meant to run every five minutes. Vercel Hobby only allows daily cron jobs, so Mailflare schedules the next run
itself with a delayed message on Vercel Queues. It starts with the first queued job; to start it right after
deploying:

```bash
curl https://mail.example.com/api/internal/cron/frequent -H "Authorization: Bearer $CRON_SECRET"
```

It runs on production only. If it ever stops, the next queued job or the daily cron run in `vercel.json` (03:00 UTC)
starts it again. It uses a few queue operations every five minutes, from the same quota as the mail queues.

#### With QStash

With QStash as the queue, create a [QStash schedule](https://upstash.com/docs/qstash/features/schedules) instead,
once, with your own address and secrets:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/https://mail.example.com/api/internal/cron/frequent" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Schedule-Id: mailflare-frequent" \
  -H "Upstash-Cron: */5 * * * *" \
  -H "Upstash-Method: GET" \
  -H "Upstash-Retries: 0" \
  -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET"
```

Outside the default region, replace `https://qstash.upstash.io` with your `QSTASH_URL`. Running the command again
updates the same schedule. It uses 288 messages a day of your QStash quota, which the mail queues share.

### Bucket CORS

Bodies over 4 MB (attachments, Drive parts, imports, backup restore) go from the browser straight to storage. An
S3 or Backblaze bucket has to allow it (Vercel Blob already does). On S3:

```json
[{ "AllowedOrigins": ["https://mail.example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"] }]
```

On Backblaze B2, add a CORS rule for the `s3_put` operation with the same origin.

## Receiving mail

Vercel cannot accept SMTP. Pick one:

- **Cloudflare Email Routing relay.** Deploy `deploy/cloudflare-email-relay`, set its `MAILFLARE_URL` to the
  deployment and give both the same `INBOUND_WEBHOOK_SECRET`. Route the catch-all to it. If Mailflare manages the
  zone with `CF_TOKEN`, also set `CF_EMAIL_WORKER_NAME=mailflare-email-relay` so the rules it creates point at the
  relay. A relay deployed earlier must be redeployed: only the current one can deliver messages over 4 MB (with Vercel Blob
  too).
- **Resend or Amazon SES**, chosen per domain on the Domains page ([providers](providers.md)).

## Sending mail

Resend or Amazon SES per domain, `SMTP_URL`, or `CF_ACCOUNT_ID` with `CF_TOKEN`, as in
[self-hosting](self-hosting.md#sending-mail).

## Limits

- **No live push in the browser.** Lists refresh every 30 seconds. Web Push notifications still work with the
  `VAPID_*` variables.
- **API requests stop at 4.5 MB.** The web app works around it; the REST API, MCP and JMAP clients cannot. JMAP
  advertises a 4 MB upload limit.
- **Attachments** stay limited to 25 MB per message.
- **No IMAP import.** Import `.eml`, `.mbox` or Google Takeout files instead.
- **Rate limits** fall back to per-instance counting if the database (or Redis) is unreachable.
- **Vercel Blob** keeps no custom object metadata (an unnamed JMAP upload loses its file name), and an abandoned
  Drive upload is left for Vercel to expire.
- **Vercel Queues is in beta.** A waiting job (scheduled send, retry) runs on the deployment that queued it, so do
  not delete recent deployments.
- **Long jobs** (very large backups or imports) must finish a step within 300 seconds.
- The AI assistant needs `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`.

## Updating

The admin update button pushes the new version to your repository as on Cloudflare (`GITHUB_UPDATE_*`), and
Vercel's Git integration deploys it. Apply new database migrations from Admin settings, or turn on auto-update.

## Check a deployment

```bash
CRON_SECRET=… node scripts/vercel-smoke.mjs https://mail.example.com
```

Add `INBOUND_WEBHOOK_SECRET`, `SMOKE_TO` and `SMOKE_API_KEY` to test delivery of a small and a large message.
