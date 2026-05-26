# Email Platform

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hieunc229/mailflare)

TypeScript email service on **Cloudflare Workers** (OpenNext + Next.js), **Drizzle/D1**, and **Cloudflare Email Service**.

## Model

- **No organizations** — one user account owns domains, mailboxes, and API keys.
- **First visit:** register → **onboarding** (add domain + first mailbox) → inbox.
- **Domains:** added via **Cloudflare API** (zone must exist on your account).

## Domain API (yes, programmatic)

Domains are **not** dashboard-only. This app calls Cloudflare when you add/remove a domain:

| Action | Cloudflare API |
|--------|----------------|
| List DNS / status | `GET /zones/{zone_id}/email/routing/dns` |
| Enable inbound routing + MX/SPF/DKIM | `POST /zones/{zone_id}/email/routing/dns` |
| Disable routing | `DELETE /zones/{zone_id}/email/routing/dns` |
| Enable subdomain sending + DNS | `POST /zones/{zone_id}/email/sending/subdomains` |
| Remove subdomain sending | `DELETE /zones/{zone_id}/email/sending/subdomains/{tag}` |
| Subdomain sending DNS records | `GET .../subdomains/{tag}/dns` |

**Requirements:** Prefer `CF_TOKEN` with Zone Read + Email Routing Edit + Email Sending Edit + Email Routing Rules Write (or broader). If you use a legacy Global API Key instead, set `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL`. The hostname must be the account's Cloudflare zone apex or a subdomain under that zone. Root-domain sending uses the Cloudflare Email Service binding, while subdomain sending can also provision the sending-subdomain DNS records. Mailbox creation creates a Cloudflare Email Routing rule that sends that address to `CF_EMAIL_WORKER_NAME` (`lumal` by default).

App routes:

- `GET/POST /api/domains` — list / add (calls Cloudflare)
- `GET/DELETE /api/domains/[id]` — get / remove (disables routing & sending on CF)
- `GET /api/domains/[id]/dns` — routing + sending DNS snapshot

## Setup

```bash
cp .dev.vars.example .dev.vars
# Add CF_TOKEN and optionally CF_ACCOUNT_ID.
# For a legacy Global API Key, use CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL instead.

npm install
npm run db:migrate:local
npm run dev
```

Register at `/register`, complete `/onboarding`, or seed dev data:

```bash
curl -X POST http://localhost:3000/api/seed
```

## Deploy

### One-click Cloudflare deploy

Publish this repository to GitHub, then replace `hieunc229/mailflare` in the button at the top of this README with the public repository path.

The deploy flow reads `wrangler.jsonc`, provisions the Worker bindings, prompts for values from `.dev.vars.example`, runs D1 migrations, builds the OpenNext Worker, and deploys it.

Required setup values:

- `CF_TOKEN` — scoped Cloudflare API token with Zone Read, Email Routing Edit, Email Sending Edit, and Email Routing Rules Write.
- `CF_ACCOUNT_ID` — optional unless your token can access multiple accounts.
- `CF_EMAIL_WORKER_NAME` — must match the Worker name in `wrangler.jsonc`; default is `lumal`.

After deployment, route inbound mail to the Worker in Cloudflare Email Routing.

### Manual deploy

```bash
npm run deploy
```

`npm run deploy` applies remote D1 migrations before deploying. Cloudflare's deploy button can auto-provision the D1 database, R2 bucket, and queues declared in `wrangler.jsonc`; for manual deployments, create or update those bindings in Cloudflare if they do not already exist.
