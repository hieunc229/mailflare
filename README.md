# Email Platform

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hieunc229/mailflare)

TypeScript email service on **Cloudflare Workers** (OpenNext + Next.js), **Drizzle/D1**, and **Cloudflare Email Service**.

## Model

- **No organizations** — one user account owns domains, mailboxes, and API keys.
- **First visit:** register → **onboarding** (add domain + first mailbox) → inbox.
- **Domains:** added via **Cloudflare API** (zone must exist on your account).

### Features

- [x] Domain onboarding through Cloudflare, including inbound Email Routing DNS and sending DNS setup.
- [x] Domain removal cleanup for linked Cloudflare routing rules and sending subdomain resources.
- [x] Mailbox creation with automatic Cloudflare Email Routing rules.
- [x] Mailbox management with a grid view, mailbox detail page, and editable display name.
- [x] Inbox, sent, drafts, spam, and trash folders backed by a shared mail list component.
- [x] Popup composer with autosaved drafts and draft resume from the drafts folder.
- [x] Outbound send API, API keys, message read status, spam/trash moves, and seeded demo data.
- [] Advanced routing rules for catch-all addresses, forwarding, reject/block rules, and priorities.
- [] Webhook management UI and delivery retry visibility.
- [] Search, filtering, and richer mailbox/folder counts.
- [] Attachment support and richer compose formatting.

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

**Requirements:** Prefer `CF_TOKEN` with Zone Read + Email Routing Edit + Email Sending Edit + Email Routing Rules Write (or broader). If you use a legacy Global API Key instead, set `CF_API_KEY` and `CF_EMAIL`. The hostname must be the account's Cloudflare zone apex or a subdomain under that zone. Root-domain sending uses the Cloudflare Email Service binding, while subdomain sending can also provision the sending-subdomain DNS records. Mailbox creation creates a Cloudflare Email Routing rule that sends that address to `CF_EMAIL_WORKER_NAME` (`mailflare` by default).

App routes:

- `GET/POST /api/domains` — list / add (calls Cloudflare)
- `GET/DELETE /api/domains/[id]` — get / remove (disables routing & sending on CF)
- `GET /api/domains/[id]/dns` — routing + sending DNS snapshot

## Setup

```bash
cp .dev.vars.example .dev.vars
# Add CF_TOKEN and optionally CF_ACCOUNT_ID.
# For a legacy Global API Key, use CF_API_KEY + CF_EMAIL instead.

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

Keep `wrangler.jsonc` committed. Cloudflare's deploy button uses it to detect the Worker entrypoint and required bindings. Do not commit `.dev.vars`; deploy-time secrets should be entered through Cloudflare's setup flow or set locally in `.dev.vars`.

Required setup values:

- `CF_TOKEN` — runtime scoped Cloudflare API token with Zone Read, Email Routing Edit, Email Sending Edit, and Email Routing Rules Write. This is separate from Cloudflare's deploy/build token; Cloudflare does not automatically expose the deploy token to this app.
- `CF_ACCOUNT_ID` — optional unless your token can access multiple accounts.
- `CF_EMAIL_WORKER_NAME` — must match the Worker name in `wrangler.jsonc`; default is `mailflare`.

If you rename the Worker, also update related literal resource names in `wrangler.jsonc`: `name`, `services[].service` for `WORKER_SELF_REFERENCE`, `CF_EMAIL_WORKER_NAME`, and any D1/R2/Queue names you want renamed. Cloudflare service bindings require the target Worker name to exist exactly; they cannot currently reference `name` dynamically.

After deployment, route inbound mail to the Worker in Cloudflare Email Routing.

### Cloudflare token troubleshooting

If onboarding fails with `Cloudflare API 403 ... code 9109: Invalid access token`, Cloudflare rejected the credential before checking domain permissions.

The Deploy to Cloudflare flow can authenticate and deploy the Worker, but it does not create a runtime `CF_TOKEN` for Mailflare's onboarding API calls. Create `CF_TOKEN` manually from Cloudflare dashboard user API tokens and enter it as a deploy secret/variable.

Verify the token:

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer <CF_TOKEN>"
```

The response should include `"success": true` and `"status": "active"`. In `.dev.vars` or deploy settings, set `CF_TOKEN` to the token secret value only. Do not include the word `Bearer`, do not use the token ID, and do not put a Global API Key in `CF_TOKEN`. For a Global API Key, set both `CF_EMAIL` and `CF_API_KEY` instead.

Also check whether the token has an expiration, a `not_before` time, or client IP restrictions. If you changed deploy variables in Cloudflare, redeploy so the Worker receives the new values.

### Manual deploy

```bash
npm run deploy
```

`npm run deploy` applies remote D1 migrations before deploying. Cloudflare's deploy button can auto-provision the D1 database, R2 bucket, and queues declared in `wrangler.jsonc`; for manual deployments, create or update those bindings in Cloudflare if they do not already exist.
