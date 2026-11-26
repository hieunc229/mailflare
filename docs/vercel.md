# Deploying Mailflare to Vercel (experimental)

Cloudflare Workers (see [deployment](deployment.md)) and [Docker](self-hosting.md) are the recommended ways to run
Mailflare. Vercel works, with more services to set up and the [limits](#limits) below.

## What you need

| Service | Used for | Variables |
| --- | --- | --- |
| Vercel Hobby or Pro | The app, with 300 s functions. Hobby is for non-commercial use only. | |
| PostgreSQL, MySQL or Turso ([databases](databases.md)) | All records | `DATABASE_URL` (and `DATABASE_AUTH_TOKEN` for Turso) |
| AWS S3 or Backblaze B2 | Raw mail, attachments, Drive, backups | `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, or the four `B2_*` |
| [Upstash QStash](https://upstash.com/docs/qstash) | Job queues | `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` outside the default region) |
| Upstash Redis | Login and API rate limits | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (the `KV_REST_API_*` names work too) |
| | Protects the cron routes | `CRON_SECRET`: a long random string |
| | Public address | `APP_URL=https://mail.example.com`; defaults to the project's production domain |

The app refuses to start and lists what is missing until all of these are set.

A PostgreSQL provider with an HTTP driver (Neon) or a connection pooler suits serverless functions best, because
each query otherwise opens its own connection.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhieunc229%2Fmailflare&env=DATABASE_URL,S3_BUCKET,S3_REGION,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY,QSTASH_TOKEN,QSTASH_CURRENT_SIGNING_KEY,QSTASH_NEXT_SIGNING_KEY,UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN,CRON_SECRET&envDescription=See%20docs%2Fvercel.md&envLink=https%3A%2F%2Fgithub.com%2Fhieunc229%2Fmailflare%2Fblob%2Fmain%2Fdocs%2Fvercel.md)

1. Import the repository and set the variables above. `vercel.json` sets the build command and daily cron jobs.
2. [Allow browser uploads on the bucket](#bucket-cors).
3. Turn off Deployment Protection for the production domain: QStash, cron and mail providers must reach it.
4. Open `/setup`, create the admin account and add your domain.
5. [Add the five-minute schedule](#five-minute-schedule).

Preview deployments need their own database, bucket and `APP_URL`; otherwise their queued jobs run on production.

### Five-minute schedule

Follow-up and calendar reminders, the import sweep, the promotions backfill, auto-update and other housekeeping are
meant to run every five minutes. Vercel Hobby only allows daily cron jobs, so `vercel.json` runs them once a day
(03:00 UTC) as a fallback, and a [QStash schedule](https://upstash.com/docs/qstash/features/schedules) runs them on
time. Create it once, with your own address and secrets:

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

Bodies over 4 MB (attachments, Drive parts, imports, backup restore) go from the browser straight to the bucket.
Allow it on S3 with:

```json
[{ "AllowedOrigins": ["https://mail.example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"] }]
```

On Backblaze B2, add a CORS rule for the `s3_put` operation with the same origin.

## Receiving mail

Vercel cannot accept SMTP. Pick one:

- **Cloudflare Email Routing relay.** Deploy `deploy/cloudflare-email-relay`, set its `MAILFLARE_URL` to the
  deployment and give both the same `INBOUND_WEBHOOK_SECRET`. Route the catch-all to it. If Mailflare manages the
  zone with `CF_TOKEN`, also set `CF_EMAIL_WORKER_NAME=mailflare-email-relay` so the rules it creates point at the
  relay. A relay deployed earlier must be redeployed: only the current one can deliver messages over 4 MB.
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
- **Rate limits** fall back to per-instance counting if Redis is unreachable.
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
