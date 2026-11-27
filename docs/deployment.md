# Deployment and configuration

Cloudflare deployment, configuration, backups and updates. Elsewhere: [Docker](self-hosting.md), [Vercel](vercel.md).

## Overview

1. **Deploy the app:** Deploy to Cloudflare button, app name `mailflare`, required `CF_TOKEN`.
2. **Complete setup:** open the app, follow `/setup`, create the first admin account.
3. **Connect your domain:** a domain on the same Cloudflare account; choose which service receives its mail. Mailflare configures email routing and (when available and selected) email sending, then helps create the first mailbox. Resend and Amazon SES are alternatives for receiving and sending; see [Sending and receiving providers](providers.md).

## Step 1: Setup CF_TOKEN
`CF_TOKEN` is a scoped Cloudflare API token.

1. In your Cloudflare account, navigate to `Manage Account` → `Account API Tokens` and create a new token.
2. At the top of the Policy window, select `Specified Domains` for all domains you plan to connect
    1. Then configure these permissions
        1. DNS & Zones > DNS > Select `Edit` Access
            1. This allows the confirmed setup flow to replace conflicting MX records
        2. DNS & Zones > Zone > Select `Read` Access
        3. DNS & Zones → Zone Settings → Select `Edit` Access
        4. Email & Messaging > Email Routing Rules > Select `Edit` Access
3. To send mail: add another policy and select `Entire Account`, and configure these permissions:
    1. Email & Messaging > Email Sending > Select `Edit` Access
4. Go to `Compute` → `Email Service` → `Email Sending`
    1. Workers Paid is needed to send to any address; on Workers Free, Email Sending only delivers to verified addresses
    2. Select On-board domain and follow the prompts
    3. After Mailflare setup, expand the domain on Admin > domains to configure DKIM and DMARC records

Optionally, add `Workers AI` > `Read` on the account so the assistant can list Workers AI models; without it a built-in list is shown.

Paste only the token secret into the `CF_TOKEN` field in step 2: no `Bearer`, not the token ID. The token must belong to the same Cloudflare account as the domains you connect.

## Step 2: Deploy mailflare

1. Click **Deploy to Cloudflare**; sign in if prompted.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hieunc229/mailflare)

2. Choose the Cloudflare account that owns the domain.
3. Set the app name to exactly `mailflare`. Do not rename it.
4. Add `CF_TOKEN` when asked for runtime variables or secrets (distinct from the token Cloudflare uses to deploy).
5. Start the deployment and wait for the Worker to deploy.


### Optional Web Push configuration

For background new-mail notifications, run `npm run push:keys` once. Store `VAPID_PRIVATE_KEY` as a Worker secret; set `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` as Worker variables. The subject is a `mailto:` URI or the installation's public HTTPS URL. Keep the same key pair across deployments so existing browser subscriptions stay valid.

## Step 3: Complete mailflare setup

1. Open the URL of the deployed `mailflare` Worker.
2. Go to `/setup` if Mailflare does not take you there automatically.
3. Mailflare checks the Cloudflare configuration and initializes the empty D1 database, applying the committed migrations through the Worker's D1 binding.
4. Create the first admin account when prompted.

For PostgreSQL, MySQL, Turso/libSQL or another database instead of D1, set `DATABASE_URL` (and `DATABASE_DRIVER` when it cannot be inferred) as a Worker variable or secret before setup. Setup and **Update database** then apply that database's migrations. See [Databases](databases.md).

## Step 4: Connect your primary domain and create an account

1. Enter a domain on Cloudflare DNS in the same account as your `CF_TOKEN`.
2. Continue; Mailflare enables Email Routing and configures routing and sending DNS.
3. Choose the first mailbox address and finish setup.
4. Open the inbox and send a test message to the new address.

More domains: **Admin → Domains** → **New domain**, enter the hostname, choose the receiving service. Cloudflare: Email Routing and Email Sending are configured automatically. Resend or Amazon SES: add the provider's credentials and run its setup from the domain page; see [Sending and receiving providers](providers.md). `CF_TOKEN` is needed in every case, because Cloudflare manages the domain's DNS.

Resend and SES receive mail by calling your app: set `APP_URL` to the public HTTPS address before setting them up for receiving.

---

## Deploy with an AI coding agent

Paste the prompt below into an agent with terminal access. Give it your Cloudflare account ID and **two separate scoped API tokens** through the agent's secret input. Never put them in a public chat, repository or committed file.

- **Deployment token** (Wrangler's `CLOUDFLARE_API_TOKEN`): target account, with **Workers Scripts Edit** (or **Workers Admin** if you see Cloudflare's newer roles), **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit**, and **Account Settings Read**. Add **Workers Routes Edit** (target zone only) if the agent should attach a custom domain or route. See Cloudflare's [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/).
- **Runtime token** (stored as the Worker secret `CF_TOKEN`): use the domain permissions above. Add **Email Sending Edit** to send mail. It must cover the zones you will connect in Mailflare.

```text
Install Mailflare from https://github.com/hieunc229/mailflare in my Cloudflare account.
Ask me for my Cloudflare account ID, a scoped deployment API token, and a separate
runtime CF_TOKEN through a secret input. Never print, commit, or place either token
in a command argument or a tracked file. Use the deployment token only for Wrangler
authentication (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).

Read README.md, docs/deployment.md, and wrangler.jsonc first. Keep the Worker name
exactly mailflare. In the selected account, create or reuse the D1 database
mailflare, R2 bucket mailflare-raw, and Queues mailflare-inbound,
mailflare-outbound, and mailflare-agent. Set the D1 database_id in the local
Wrangler config without committing that account-specific ID. Install dependencies,
run npm run deploy, and set the runtime CF_TOKEN as a Worker secret. Do not run
remote D1 migrations manually; the /setup flow initializes the database.

Give me the deployed URL and any remaining Cloudflare account actions. I will
open /setup, create the first admin account, and connect my domain there.
```

## Manual deployment

Install dependencies, configure the Cloudflare bindings in `wrangler.jsonc`, and run:

```bash
npm install
npm run deploy:local
```

This builds with vinext and uploads the complete Worker with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to that build. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups and the real-time Durable Object.

Manual recovery for pending migrations:

```bash
npm run db:migrate:remote
```

Needs the target account's `database_id` in your local `wrangler.jsonc`. Do not commit it to a reusable repository.

## Object storage (R2, Backblaze B2 or AWS S3)

Raw mail, attachments, Drive files, avatars, branding icons, JMAP uploads and backups live in one bucket: by default the `BUCKET` R2 binding in `wrangler.jsonc`. For Backblaze B2, set four Worker variables (secrets, or `.dev.vars` locally):

| Variable | Example | Purpose |
| --- | --- | --- |
| `B2_KEY_ID` | `004abc...` | Application key ID |
| `B2_APPLICATION_KEY` | `K004...` | Application key secret |
| `B2_BUCKET` | `mailflare` | Bucket name |
| `B2_ENDPOINT` | `s3.us-west-004.backblazeb2.com` | S3-compatible endpoint from the bucket page; the region is read from it |

```bash
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_BUCKET
npx wrangler secret put B2_ENDPOINT
```

For AWS S3, set `S3_BUCKET`, `S3_REGION` and credentials: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, which fall back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` so one IAM user can serve SES and storage. The bucket must be private and in the named region; the IAM user needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on `arn:aws:s3:::<bucket>/*`. If both are configured, B2 wins.

With all four B2 variables (or the S3 ones) present, that storage replaces R2 everywhere; with any missing, R2 stays in use (`GET /api/v1/storage` reports a partial setup). The R2 binding can stay in `wrangler.jsonc`, unused. Use a bucket-restricted application key with read and write access; keep the bucket private.

- **Switching does not copy data.** Objects already in R2 are not moved; copy them to the bucket first (for example with `rclone`, keeping the same keys) or old mail bodies, attachments and Drive files will report as missing.
- **Drive upload parts** are buffered one at a time in the Worker (64 MiB each). B2 and S3 require every part but the last to be at least 5 MiB, which holds.
- **Lifecycle.** Set the bucket's lifecycle rule to keep only the last version and delete unfinished large files after a few days (R2 aborts incomplete multipart uploads itself).
- **Test it** with `POST /api/v1/storage` (admin key with the `storage` scope), or the `manage_storage` MCP tool with `action: "test"`; it writes, reads and deletes a small object.

## Database backups

D1 records are exported as JSON into the configured storage bucket (R2, or Backblaze B2 when configured). A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule selected under **Admin → Backups**. Manual backups run the same export from the admin API.

Deploy the complete Worker with `npm run deploy` whenever the cron trigger is added or changed.

After upgrading an existing installation and confirming the cron trigger is active, remove the old Workflow with `npx wrangler workflows delete mailflare-database-backup`. This also removes its historical Workflow instances; backup files and backup history rows are unaffected.

## Email assistant and MCP

Uses the Workers AI `AI` binding and a separate `mailflare-agent` queue. Provision the queue before deploying a configuration that declares it, and apply migration `0032_add_agentic_mail.sql` before opening the new UI on an existing database. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

Inbox → **Assistant → Settings** for a mailbox: select its reviewer, enable the assistant. Auto-drafting is a separate opt-in; it skips spam, automated mail and mailboxes with out-of-office replies enabled. Generated replies are ordinary drafts assigned to the reviewer, who must open the draft and confirm the exact content before delivery.

The assistant panel does not manage MCP keys. External MCP clients connect to `https://<your-mailflare-origin>/mcp` with a mailbox-scoped Bearer key. Create it in **Settings → API keys** with **Allow MCP access** enabled; the page calls `/api/agent/mcp-keys`, which also lists and revokes MCP keys. A new key is shown only once. The server uses Streamable HTTP and needs a client that can set a Bearer header. Its `request_send` tool returns a Mailflare review URL; the MCP key cannot confirm or deliver messages directly. MCP does not require Workers AI for read and draft tools.

## Updating Mailflare

The admin dashboard's **Update Mailflare** button dispatches `.github/workflows/deploy-update.yml` in the installation repository. The workflow replaces the installation branch's whole tracked tree with the latest upstream source, commits and pushes it (no merge conflicts between independent histories). Target-only committed files and code changes are intentionally removed; repository variables, secrets and other GitHub or Cloudflare configuration are unchanged. A connected Cloudflare Git integration then builds and deploys.

### Auto update

Create a fine-grained personal access token for the installation repository with these repository permissions:

| Permission | Access | Used for |
| --- | --- | --- |
| Actions | Read and write | Dispatching `deploy-update.yml` from the Mailflare admin dashboard |
| Contents | Read and write | Committing and pushing the upstream source into the installation repository |
| Workflows | Read and write | Replacing files inside `.github/workflows` during an update |

Configure in both Cloudflare and GitHub:

| Location | Name | Type | Value |
| --- | --- | --- | --- |
| Cloudflare Worker | `GITHUB_UPDATE_TOKEN` | Secret | The fine-grained personal access token |
| Cloudflare Worker | `GITHUB_UPDATE_REPO` | Variable | The installation repository in `owner/repository` format |
| Cloudflare Worker | `GITHUB_UPDATE_REF` | Optional variable | The installation branch to update; omit it to use the repository's default branch |
| GitHub repository → Actions | `MAILFLARE_UPDATE_TOKEN` | Repository secret | The same fine-grained personal access token |
| GitHub repository → Actions | `UPDATE_SOURCE_REPOSITORY` | Optional repository variable | The upstream repository; defaults to `hieunc229/mailflare` |

The same token can be used for `GITHUB_UPDATE_TOKEN` and `MAILFLARE_UPDATE_TOKEN` when it has all three permissions above. Keep both values secret and limit the token's repository access to the installation repository.

`.github/workflows/deploy-update.yml` must exist on the installation branch. If missing, create it from the [canonical Mailflare update workflow](https://github.com/hieunc229/mailflare/blob/main/.github/workflows/deploy-update.yml). An older installation with a different updater needs the canonical workflow installed once; a running workflow cannot create or replace itself until the current one is installed manually.

After the GitHub Action succeeds, wait for the connected Cloudflare deployment to finish before refreshing Mailflare or applying migrations: the new version is not live until Cloudflare completes its deployment.

Deployment and database migration are separate. After Cloudflare deploys, open or refresh **Admin settings**; the application update card shows pending database migrations. Select **Update database** to apply them through the Worker's D1 binding (the same runner initializes a new database during setup).

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

Each migration and its `d1_migrations` entry run in one D1 batch. A failed migration is rolled back, its filename shown, and it can be retried after the fix. Wrangler remains available for manual recovery.

If mail arrives after a deploy but before its migrations are applied and the new code needs a column or table that does not exist yet, the inbound queue retries that message every 5 minutes, up to 12 times (about an hour), instead of dropping it. Applying the migrations inside that hour, from **Update database** or with automatic updates enabled (the 5-minute cron applies them), delivers the held mail. Mail still failing after that is lost from the queue and its raw copy in R2 is deleted by the daily sweep, so apply migrations promptly after a deploy. The self-hosted Node server applies migrations at startup before it consumes mail, so it does not hit this.

Releases must stay compatible with the previous schema until an administrator applies their migrations: prefer additive changes, keep old columns during the transition, and do not make authentication or the admin settings page depend immediately on a new column. Plan a maintenance window for an incompatible schema change.

Schema change: add a new uniquely named SQL file in `drizzle/migrations`; never edit an applied migration. Build and dev commands generate the Worker migration bundle from those files; `npm run db:bundle` generates it explicitly.

## Branding license

Activate a purchased Pro or Team key from **Admin → Licenses**. Mailflare sends the key to Paymug and stores only a one-way hash and the activation state. Apply all D1 migrations before activating a license.
