# Self-hosting Mailflare (Docker)

Runs as a single container on any host instead of Cloudflare Workers (same code). The container provides its own database (SQLite on a volume), blob storage (files on the same volume), job queue, realtime WebSocket, backup schedule and an SMTP listener for inbound mail.

## Quick start

```bash
git clone https://github.com/hieunc229/mailflare && cd mailflare
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose up -d --build
```

Open `http://your-host:3000/setup`, create the admin account, add your domain. All data lives in the `mailflare-data` volume (`/data`): SQLite database, raw messages, attachments, backups.

Behind a reverse proxy:

- Set `APP_URL=https://mail.example.com` so password-reset links and the JMAP session use the public address.
- Forward WebSocket upgrades for `/api/realtime`.
- Set `TRUST_PROXY=1`; without it every request appears to come from the proxy, so login rate limits are shared by all users. Leave unset when exposed directly.
- Passkeys bind to this origin, so they need `APP_URL` (or a direct HTTPS connection).

### Prebuilt image (no build)

Every push to `main` publishes a multi-arch (`linux/amd64`, `linux/arm64`) image to `ghcr.io/hieunc229/mailflare`:

```bash
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose -f docker-compose.image.yml up -d
```

`docker-compose.image.yml` needs only that file and `.env.docker` (no source checkout). `docker-compose.yml` builds from source.

| Tag | Meaning |
| --- | --- |
| `latest` | Newest build of `main`. |
| `<version>` (the `package.json` version, e.g. `0.5.6`) | Newest build of `main` with that version. It moves while the version stays the same. |
| `sha-abc1234` | One exact commit. Never moves; pin this to roll back or hold a version. |

**Upgrade (NAS or server).**

1. Back up: copy the `mailflare-data` volume, or download a backup from the admin Backups page.
2. Pull the image and recreate the container: `docker compose -f
   docker-compose.image.yml pull && docker compose -f docker-compose.image.yml up -d`.
   On a NAS UI, do the same there.
3. Keep the volume and `.env.docker`; they hold your data and settings.

Pending migrations run at container start, before serving requests. A failed migration stops the start (the container exits; see `docker compose logs`). Migrations only move forward: to go back after one was applied, pin an older `sha-` tag and restore the volume or backup from step 1.

Turnstile is not in the prebuilt image (its site key is fixed at build time). Build from source with
`docker build --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=<key> .` (or set the arg under `build:` in `docker-compose.yml`) and set `TURNSTILE_SECRET_KEY`.

### PWA and push notifications

Mailflare installs as a PWA and can deliver new-mail notifications after the browser is closed. Generate one VAPID key pair per installation:

```bash
npm run push:keys
```

Set the printed `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in the runtime environment, plus `VAPID_SUBJECT` (a `mailto:` contact or the installation's public HTTPS URL). Keep the private key secret. Browsers require HTTPS for service workers and Web Push (localhost excepted). Users enable push under **Settings → Inbox → Notifications**.

## Receiving mail

Pick one; both can be on at once.

**Built-in SMTP listener (default).** Listens on port 25 and accepts mail for every domain you add. Point the domain's MX record at the host, set `MAIL_HOSTNAME` to the host's name, and make port 25 reachable from the internet (several clouds block it by default; Hetzner and most VPS providers do not). The app's domain page lists the MX, SPF and DMARC records to create. Routing rules work as on Cloudflare: reject rules answer the sender with a 550 during delivery; forward rules relay the message through your outbound SMTP.

Optional: `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths inside the container) enable STARTTLS with your own certificate. Without them STARTTLS is not offered: safe, but transport encryption depends on the sender.

**Cloudflare Email Routing relay.** Keep MX on Cloudflare and deploy the Worker in `deploy/cloudflare-email-relay`. It posts each message to `/api/inbound` on your server, signed with `INBOUND_WEBHOOK_SECRET`, and acts on the reject or forward decision returned. Set `SMTP_INBOUND_PORT=0` to disable the listener.

## Sending mail

**Any SMTP relay.** `SMTP_URL=smtps://user:pass@host:465` (or `smtp://` with STARTTLS). Works with your hosting provider's relay, Amazon SES, Postmark, Mailgun or your own Postfix. Set `SMTP_TLS_REJECT_UNAUTHORIZED=false` only for a relay with a self-signed certificate on a private network.

**Cloudflare Email Sending.** `CF_ACCOUNT_ID` plus a `CF_TOKEN` with Email Sending: Edit. The domain must be a Cloudflare zone with Email Sending set up; Mailflare calls the REST API, no Workers plan needed.

**Resend or Amazon SES, per domain.** Instead of one global relay, each domain can send (and receive, once Mailflare can manage its DNS with `CF_TOKEN`) through the Resend or SES APIs, no SMTP involved. Add credentials on the domain page, or set `RESEND_API_KEY` / `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`. Receiving needs `APP_URL` set to your public HTTPS address. See [Sending and receiving providers](providers.md). SES as a plain SMTP relay through `SMTP_URL` still works and needs none of this.

## Cloudflare zone management (optional)

If `CF_TOKEN` can also edit DNS and Email Routing on your zones, adding a domain configures Email Routing and the sending subdomain automatically, as on Workers. Without it, domains are recorded as manually managed and the DNS page shows what to set by hand.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database, blobs and backups |
| `DATABASE_URL` | unset | Use PostgreSQL, MySQL or libSQL instead of the SQLite file in `DATA_DIR`; see [Databases](databases.md). Migrations are applied on start. |
| `DATABASE_DRIVER` | inferred | Only to override the driver inferred from `DATABASE_URL` |
| `APP_URL` | request origin | Public URL behind a proxy. Browser requests that change data must come from this origin. Required for password reset on the self-hosted server: reset links are never built from the `Host` header, so without it no reset email is sent. |
| `TRUST_PROXY` | unset | Set to `1` when a reverse proxy terminates TLS in front of the container: its `X-Forwarded-For` client IP and `X-Forwarded-Proto` scheme are then trusted (without `APP_URL`, the same-origin check uses `Host` plus that scheme). Leave unset when exposed directly. |
| `SMTP_INBOUND_PORT` | `25` | Inbound SMTP; `0` disables |
| `MAIL_HOSTNAME` | `mail.<domain>` | Host the MX record points at; SMTP banner |
| `SMTP_MAX_SIZE` | 36 MiB | Largest raw inbound message; allows for encoding overhead on up to 25 MB of attachments. Oversized mail receives an SMTP rejection, which the sender's mail provider can report as a delivery failure. |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | unset | STARTTLS certificate for the listener |
| `SMTP_URL` | unset | Outbound relay |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Trust self-signed relay certificates when `false` |
| `CF_EMAIL_WORKER_NAME` | `mailflare` | Worker name that Email Routing rules created through the Cloudflare API target. If you change it on an install whose rules already target `mailflare`, recreate those rules; the old ones are no longer recognised |
| `CF_ACCOUNT_ID`, `CF_TOKEN` | unset | Cloudflare Email Sending, and zone management if the token allows |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` | unset | Store blobs in Backblaze B2 (all four required) instead of files under `/data/blobs`; see [Deployment](deployment.md#object-storage-r2-backblaze-b2-or-aws-s3) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset | Store blobs in AWS S3; the keys fall back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Backblaze wins if both are set |
| `RESEND_API_KEY` | unset | Resend key; overrides one saved in the app |
| `RESEND_BASE_URL` | `https://api.resend.com` | Base URL of the Resend API; set it to use a Resend-compatible service |
| `RESEND_CUSTOM_MESSAGE_ID` | `true` | Set to `false` for a Resend-compatible service that refuses a custom `Message-ID` header |
| `RESEND_OMIT_HEADERS` | empty | Comma-separated headers left out of Resend sends, for a compatible service that refuses them (e.g. `Auto-Submitted`) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | unset | Amazon SES credentials; override ones saved in the app |
| `INBOUND_WEBHOOK_SECRET` | unset | Enables `/api/inbound` for the relay Worker |
| `INBOUND_REQUIRE_SIGNED_HEADERS` | unset | Set to `1` once the relay Worker is updated: refuses relays that do not sign the header map with a timestamp (older relays stay accepted without it, and their requests can be replayed) |
| `TURNSTILE_SECRET_KEY` | unset | Bot protection on login and reset forms (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time) |
| `VAPID_PUBLIC_KEY` | unset | Public Web Push application-server key |
| `VAPID_PRIVATE_KEY` | unset | Secret Web Push application-server key |
| `VAPID_SUBJECT` | unset | Web Push contact URI (`mailto:` or HTTPS) |
| `AI_BASE_URL` | unset | OpenAI-compatible model API base URL for the assistant |
| `AI_API_KEY` | unset | Server-only key for that model API |
| `AI_MODEL` | `gpt-4o-mini` | Model ID supported by the configured API |

## Operations

- **Backups.** Daily 02:00 UTC backup and the admin Backups page work unchanged; files land under `/data/blobs/backups`. Back up the whole volume for a full copy.
- **Updates.** Pull the new image and recreate the container; migrations run at start (see [Prebuilt image](#prebuilt-image-no-build)). The in-app update button is disabled on self-hosted installs.
- **Logs.** `docker compose logs -f mailflare`.
- **Queues.** Jobs are held in memory and not re-queued after a restart. Inbound mail is written to the volume before queuing, but a message whose job is lost stays unparsed, and the nightly clean-up removes raw inbound files no message references after 24 hours. Scheduled and undo-send mail not yet sent at restart is not sent automatically.

## Email assistant and MCP

Set `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` in the container environment (server-only). Assistant chat is available by default once a provider is configured; a mailbox manager changes its writing instructions and availability via the settings button in the assistant panel. Automatic reply drafts stay off until enabled there. Auto-draft work is recorded in SQLite and retried after a restart by the local scheduler. AI failure does not reject inbound mail. Out-of-office auto-replies and AI auto-drafts are separate; turn off out-of-office replies before enabling auto-drafts for a mailbox.

The MCP endpoint is `/mcp`. Create a key in **Settings → API keys** with **Allow MCP access** enabled, choose its mailboxes and tools, and give it to a client that supports custom HTTP headers. The endpoint uses Streamable HTTP; `request_send` gives the client a review URL, and only an authenticated Mailflare browser session can confirm delivery. MCP read and draft tools remain available when no AI model is configured.

## Running without Docker

```bash
npm ci
npm run build:node
MAILFLARE_RUNTIME=node NODE_ENV=production DATA_DIR=./data node dist/server.mjs
```

Port 25 needs root or a capability (`setcap cap_net_bind_service=+ep`); otherwise use `SMTP_INBOUND_PORT=2525` behind a port forward.
