# Self-hosting Mailflare (Docker)

Mailflare can run as a single container on any host instead of Cloudflare
Workers. The same code serves both; the container provides its own database
(SQLite on a volume), blob storage (files on the same volume), job queue,
realtime WebSocket, backup schedule and an SMTP listener for inbound mail.

## Quick start

```bash
git clone https://github.com/hieunc229/mailflare && cd mailflare
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose up -d --build
```

Open `http://your-host:3000/setup`, create the admin account and add your
domain. All data lives in the `mailflare-data` volume (`/data` in the
container): the SQLite database, raw messages, attachments and backups.

Behind a reverse proxy, set `APP_URL=https://mail.example.com` so links in
password-reset mail and the JMAP session point at the public address, and
forward WebSocket upgrades for `/api/realtime`. Passkeys also bind to this
origin, so they need `APP_URL` (or a direct HTTPS connection) to work.

### PWA and push notifications

Mailflare can be installed as a PWA and can deliver new-mail notifications
after the browser is closed. Generate one VAPID key pair for the installation:

```bash
npm run push:keys
```

Set the printed `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` values in the
runtime environment, plus `VAPID_SUBJECT` as either a `mailto:` contact or the
public HTTPS URL of the installation. Keep the private key secret. Browsers
require HTTPS for service workers and Web Push (localhost is the development
exception). Users can then enable push under **Settings → Inbox → Notifications**.

## Receiving mail

Pick one; both can be on at once.

**Built-in SMTP listener (default).** The container listens on port 25 and
accepts mail for every domain you add. Point the domain's MX record at the
host, set `MAIL_HOSTNAME` to that host's name, and make sure port 25 is
reachable from the internet (several clouds block it by default; Hetzner and
most VPS providers do not). The domain page in the app lists the MX, SPF and
DMARC records to create. Domain routing rules work as on Cloudflare: reject
rules answer the sender with a 550 during delivery, forward rules relay the
message through your outbound SMTP.

Optional: `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths inside the container)
enable STARTTLS with your own certificate. Without them STARTTLS is not
offered, which is safe but means transport encryption depends on the sender.

**IMAP (mail apps, read-only for now).** Set `IMAP_ENABLED=1`, give the container
`SMTP_TLS_KEY` and `SMTP_TLS_CERT` for `MAIL_HOSTNAME`, and publish port 993
(uncomment `"993:993"` in `docker-compose.yml`). Then create an app password with
the IMAP protocol in Settings, App passwords, and add an IMAP account in your
mail app: server `MAIL_HOSTNAME`, port 993, SSL/TLS, user name your mailbox
address, password the app password. Only app passwords work, never the account
password, and only over TLS; ten wrong passwords a minute from one address lock
that address out for the rest of the minute (the limit is shared with CalDAV and
JMAP). Mailboxes shared with you appear under `Shared/<address>/`. Running more
than one container against the same database with IMAP on is not supported.
Workers installs cannot run IMAP: Cloudflare Workers cannot accept TCP connections.

Every failed login writes one line to the container log (standard output), and
nothing to the database:

```
IMAP login failed ip=203.0.113.7 reason=bad_secret user="me@example.test"
```

`ip` is the client address (an IPv6 client appears as its /64, for example
`2001:db8:1:2::/64`, the same unit the guess limit counts), `reason` is
`bad_secret` (no app password with that secret and the IMAP protocol),
`no_mailbox` (the secret is right but the user name is not a mailbox it may
use), `throttled` (the address has spent its guesses) or `malformed` (a broken
AUTHENTICATE response), and `user` is the user name as sent, cut to 64 printable
characters and quoted. The password is never logged. To ban repeat offenders
with fail2ban, point a filter at the container log with a `failregex` such as
`IMAP login failed ip=<ADDR>(?:/64)? reason=`.

Behind Docker's default port publishing, the userland proxy can make every client
appear to come from the bridge gateway address. All clients then share one
per-address connection cap (30) and one login guess budget, so a single bad
client can lock everyone out. Run the container with host networking, or publish
the port on a bridge that has IPv4 and IPv6 enabled and set
`"userland-proxy": false` in the Docker daemon configuration (`daemon.json`).
Then check that the `IMAP login failed ip=` line shows real client addresses and
not the gateway address.

**Cloudflare Email Routing relay.** Keep MX on Cloudflare and deploy the
Worker in `deploy/cloudflare-email-relay`. It posts each message to
`/api/inbound` on your server, signed with `INBOUND_WEBHOOK_SECRET`, and acts
on the reject or forward decision the server returns. Set
`SMTP_INBOUND_PORT=0` if you do not want the listener at all.

## Sending mail

**Any SMTP relay.** `SMTP_URL=smtps://user:pass@host:465` (or `smtp://`
with STARTTLS). Works with your hosting provider's relay, Amazon SES,
Postmark, Mailgun, or a Postfix you run. Set
`SMTP_TLS_REJECT_UNAUTHORIZED=false` only for a relay with a self-signed
certificate on a private network.

**Cloudflare Email Sending.** `CF_ACCOUNT_ID` plus a `CF_TOKEN` with Email
Sending: Edit. The domain must be a Cloudflare zone with Email Sending set
up; Mailflare calls the REST API, no Workers plan needed.

**Resend or Amazon SES, per domain.** Instead of one global relay, each domain
can send through Resend or SES with their APIs (no SMTP involved), and receive
through them too, once Mailflare can manage the domain's DNS with `CF_TOKEN`.
Add the credentials on the domain page, or set `RESEND_API_KEY` /
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`. Receiving
through either needs `APP_URL` set to your public HTTPS address. See
[Sending and receiving providers](providers.md). Using SES as a plain SMTP
relay through `SMTP_URL`, described above, still works and needs none of this.

## Cloudflare zone management (optional)

If `CF_TOKEN` can also edit DNS and Email Routing on your zones, adding a
domain configures Email Routing and the sending subdomain automatically,
exactly as on Workers. Without it, domains are recorded as manually managed
and the DNS page shows what to set by hand.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database, blobs and backups |
| `DATABASE_URL` | unset | Use PostgreSQL, MySQL or libSQL instead of the SQLite file in `DATA_DIR`; see [Databases](databases.md). Migrations are applied on start. |
| `DATABASE_DRIVER` | inferred | Only to override the driver inferred from `DATABASE_URL` |
| `APP_URL` | request origin | Public URL behind a proxy |
| `SMTP_INBOUND_PORT` | `25` | Inbound SMTP; `0` disables |
| `MAIL_HOSTNAME` | `mail.<domain>` | Host the MX record points at; SMTP banner |
| `SMTP_MAX_SIZE` | 36 MiB | Largest raw inbound message; allows for encoding overhead on up to 25 MB of attachments. Oversized mail receives an SMTP rejection, which the sender's mail provider can report as a delivery failure. |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | unset | Certificate for inbound SMTP STARTTLS and for IMAP. The files are checked every 10 minutes and a renewed certificate is used without a restart |
| `IMAP_ENABLED` | unset (off) | `1` starts the IMAP listener (read-only for now); needs the certificate above. Adds the IMAP choice to Settings, App passwords. Docker and Node only |
| `IMAP_PORT` | `993` | IMAP over TLS; `0` disables it |
| `IMAP_STARTTLS_PORT` | `0` (off) | A plain port that requires STARTTLS before login; usually `143` |
| `IMAP_HOST` | every interface, IPv6 and IPv4 (`::`) | Address the IMAP listeners bind to. Without it the listener takes IPv6 and IPv4 together, and IPv4 only where the system has no IPv6 |
| `IMAP_MAX_CONNECTIONS` | `500` | IMAP connections for the whole process; each address may hold 30 (an IPv6 client counts by its /64) and each account 20 |
| `IMAP_ALLOW_PLAINTEXT` | unset | `1` allows login without TLS, only when `IMAP_HOST` is a loopback address (for local testing); ignored with a warning otherwise |
| `SMTP_URL` | unset | Outbound relay |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Trust self-signed relay certificates when `false` |
| `CF_ACCOUNT_ID`, `CF_TOKEN` | unset | Cloudflare Email Sending, and zone management if the token allows |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` | unset | Store blobs in Backblaze B2 (all four required) instead of files under `/data/blobs`; see [Deployment](deployment.md#object-storage-r2-or-backblaze-b2) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | unset | Store blobs in AWS S3; the keys fall back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Backblaze wins if both are set |
| `RESEND_API_KEY` | unset | Resend key, used when none is saved in the app |
| `RESEND_BASE_URL` | `https://api.resend.com` | Base URL of the Resend API; set it to use a Resend-compatible service |
| `RESEND_CUSTOM_MESSAGE_ID` | `true` | Set to `false` for a Resend-compatible service that refuses a custom `Message-ID` header |
| `RESEND_OMIT_HEADERS` | empty | Comma-separated headers left out of Resend sends, for a compatible service that refuses them (e.g. `Auto-Submitted`) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | unset | Amazon SES credentials, used when none are saved in the app |
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

- **Backups.** The daily 02:00 UTC backup and the admin Backups page work
  unchanged; files land under `/data/blobs/backups`. Back up the whole volume
  for a full copy.
- **Updates.** Pull the new image and recreate the container; migrations run
  at start. The in-app update button is disabled on self-hosted installs.
- **Logs.** `docker compose logs -f mailflare`.
- **Queues.** Jobs are held in memory. Inbound mail is written to the volume
  before it is queued, so a restart never loses a message; at worst one
  stays unparsed until it is re-imported.

## Email assistant and MCP

Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in the container environment to configure the built-in assistant. These values stay on the server. Assistant chat is available by default when a provider is configured; a mailbox manager can change its writing instructions and availability through the settings button in the assistant panel. Automatic reply drafts remain off until enabled there. Auto-draft work is recorded in SQLite and retried after a restart by the local scheduler. AI failure does not reject inbound mail. Out-of-office auto-replies and AI auto-drafts are separate features; turn off out-of-office replies before enabling auto-drafts for a mailbox.

The MCP endpoint is `/mcp`. Create a dedicated mailbox-scoped Bearer key in **Assistant → MCP** and give the key to a client that supports custom HTTP headers. The endpoint uses Streamable HTTP; `request_send` gives the client a review URL, and only an authenticated Mailflare browser session can confirm delivery. MCP read and draft tools remain available when no AI model is configured.

## Running without Docker

```bash
npm ci
npm run build:node
MAILFLARE_RUNTIME=node NODE_ENV=production DATA_DIR=./data node dist/server.mjs
```

Port 25 needs root or a capability (`setcap cap_net_bind_service=+ep`); use
`SMTP_INBOUND_PORT=2525` behind a port forward otherwise.
