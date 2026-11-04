# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, database backups, and application updates.

## Overview

Set up Mailflare in three steps:

1. **Deploy the app:** use the Deploy to Cloudflare button, set the app name to `mailflare`, and provide the required `CF_TOKEN`.
2. **Complete setup:** open the deployed app and follow `/setup` to check the installation and create the first admin account.
3. **Connect your domain:** add a domain managed by the same Cloudflare account and choose which service receives its mail. Mailflare configures email routing and, when available and selected, email sending before helping you create the first mailbox. Resend and Amazon SES are alternatives to Cloudflare for receiving and sending; see [Sending and receiving providers](providers.md).


## Step 1: Setup CF_TOKEN
To configure your `CF_TOKEN` (which is a scoped Cloudflare API Token with specific permissions), follow the below steps.

1. In your Cloudflare account, navigate to `Manage Account` → `Account API Tokens` and create a new token.
2. At the top of the Policy window, select `Specified Domains` for all domains that you plan to connect
    1. Then configure these permissions
        1. DNS & Zones > DNS > Select `Edit` Access
            1. This allows the confirmed setup flow to replace conflicting MX records
        2. DNS & Zones > Zone > Select `Read` Access
        3. DNS & Zones → Zone Settings → Select `Edit` Access
        4. Email & Messaging > Email Routing Rules > Select `Edit` Access
3. If mailflare will send emails: Add another policy and select `Entire Account`, and configure these permissions:
    1. Email & Messaging > Email Sending > Select `Edit` Access
4. After your token is setup, go to `Compute` → `Email Service` → `Email Sending`
    1. You will need to purchase a paid workers plan if you don't already have one
    2. Select On-board domain and follow the prompts
    3. After this is done, and after you have setup Mailflare, on the Admin > domains page, when you expand the domain you can then configure DKIM and DMARC records

Paste only the token secret into the `CF_TOKEN` field in step 2. Do not include the word `Bearer` and do not use the token ID. The token must belong to the same Cloudflare account as the domains you connect.

## Step 2: Deploy mailflare

1. Click **Deploy to Cloudflare** and sign in to Cloudflare if prompted.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hieunc229/mailflare)

2. Choose the Cloudflare account that owns the domain you want to use.
3. Set the app name to exactly `mailflare`. Do not rename it. 
4. Add `CF_TOKEN` when Cloudflare asks for the app's runtime variables or secrets. This is different from the CF_TOKEN that Cloudflare uses to deploy the app.
5. Start the deployment and wait for Cloudflare to finish provisioning and deploying the Worker.


### Optional Web Push configuration

To enable background new-mail notifications, run `npm run push:keys` once and
store `VAPID_PRIVATE_KEY` as a Worker secret. Configure `VAPID_PUBLIC_KEY` and
`VAPID_SUBJECT` as Worker variables; the subject must be a `mailto:` URI or the
public HTTPS URL of the installation. The same VAPID key pair should be kept
across deployments so existing browser subscriptions remain valid.

## Step 3: Complete mailflare setup

1. Open the URL of the deployed `mailflare` Worker.
2. Go to `/setup` if Mailflare does not take you there automatically.
3. Let Mailflare check the required Cloudflare configuration and initialize the empty D1 database.
4. Create the first admin account when prompted.

Setup applies the committed migrations through the Worker's D1 binding before creating the first admin account.

To store data in PostgreSQL, MySQL, Turso/libSQL or another database instead of D1, set `DATABASE_URL` (and `DATABASE_DRIVER` when it cannot be inferred) as a Worker variable or secret before running setup. The same setup and **Update database** flow then applies that database's migrations. See [Databases](databases.md).

## Step 4: Connect your primary domain and create an account

1. Enter a domain that already uses Cloudflare DNS on the same account as your `CF_TOKEN`.
2. Continue while Mailflare enables Email Routing and configures the required routing and sending DNS.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

To connect more domains later, open **Admin → Domains**, select **New domain**, enter the hostname and choose the receiving service. With Cloudflare, Mailflare configures Email Routing and Email Sending automatically. With Resend or Amazon SES, add the provider's credentials and run its setup from the domain page; see [Sending and receiving providers](providers.md). The `CF_TOKEN` is still needed in every case, because Cloudflare manages the domain's DNS.

Resend and SES receive mail by calling your app, so set `APP_URL` to the app's public HTTPS address before setting them up for receiving.

Your inbox should be ready to send and receive emails

---

## Deploy with an AI coding agent

Paste the prompt below into an agent with terminal access. Give it your Cloudflare account ID and **two separate scoped API tokens** through the agent's secret input. Never put them in a public chat, repository, or committed file.

- **Deployment token** (Wrangler uses it as `CLOUDFLARE_API_TOKEN`): scope it to the target account with **Workers Scripts Edit** (or **Workers Admin** if you see Cloudflare's newer roles), **D1 Edit**, **Workers R2 Storage Edit**, **Queues Edit**, and **Account Settings Read**. Add **Workers Routes Edit** for the target zone only if the agent should attach a custom domain or route. See Cloudflare's [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/).
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

The local deploy command builds with vinext and uploads the complete Worker with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to that build. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups, and the real-time Durable Object.

For manual recovery, pending migrations can still be applied with:

```bash
npm run db:migrate:remote
```

Remote migrations require the target account's `database_id` in your local `wrangler.jsonc`. Do not commit an account-specific database ID to a reusable repository.

## Object storage (R2, Backblaze B2 or AWS S3)

Raw mail, attachments, Drive files, avatars, branding icons, JMAP uploads and backups all live in one bucket. By default that is the `BUCKET` R2 binding in `wrangler.jsonc`. To use Backblaze B2 instead, set four Worker variables (as secrets, or in `.dev.vars` locally):

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

To use AWS S3 instead, set `S3_BUCKET`, `S3_REGION` and credentials: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, which fall back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` so one IAM user can serve SES and storage. The bucket must be private and in the named region; the IAM user needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on `arn:aws:s3:::<bucket>/*`. If both are configured, B2 wins.

When all four B2 variables (or the S3 ones) are present that storage replaces R2 everywhere; with any missing, R2 stays in use (a partial setup is reported by `GET /api/v1/storage`). The R2 binding can stay in `wrangler.jsonc` and is simply unused. Use a bucket-restricted application key with read and write access, and keep the bucket private. Notes:

- **Switching does not copy data.** Objects already in R2 are not moved; copy them to the bucket first (for example with `rclone`, keeping the same keys) or old mail bodies, attachments and Drive files will report as missing.
- **Drive upload parts** are buffered one at a time in the Worker (64 MB each). B2 and S3 require every part but the last to be at least 5 MB, which holds.
- **Lifecycle.** Set the bucket's lifecycle rule to keep only the last version and to delete unfinished large files after a few days, as R2 would abort incomplete multipart uploads.
- **Test it** with `POST /api/v1/storage` (admin key with the `storage` scope), or the `manage_storage` MCP tool with `action: "test"`; it writes, reads and deletes a small object.

## Database backups

Mailflare exports its D1 records as JSON and stores the backup files in the configured storage bucket (R2, or Backblaze B2 when configured). A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule selected under **Admin → Backups**. Manual backups run the same record export directly from the admin API.

Deploy the complete Worker with `npm run deploy` whenever the cron trigger is added or changed.

After upgrading an existing installation and confirming the cron trigger is active, the old Workflow can be removed with `npx wrangler workflows delete mailflare-database-backup`. Deleting it also removes its historical Workflow instances; backup files in storage and rows in Mailflare's backup history are unaffected.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `mailflare-agent` queue. Provision the queue in the Cloudflare account before deploying a configuration that declares it, and apply migration `0032_add_agentic_mail.sql` before opening the new UI on an existing database. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron still runs backups.

In the inbox, open **Assistant → Settings** for a mailbox, select its reviewer, and enable the assistant. Auto-drafting is a separate opt-in. It skips spam, automated mail, and mailboxes with out-of-office replies enabled. Generated replies appear as ordinary drafts assigned to the reviewer. The reviewer must open the draft and confirm the exact content before delivery.

The assistant panel no longer exposes MCP key management. External MCP clients can still connect to `https://<your-mailflare-origin>/mcp` with a mailbox-scoped Bearer key created through the authenticated `/api/agent/mcp-keys` endpoint. Keys can be listed and revoked through that endpoint; a new key is shown only once. The server uses Streamable HTTP and accepts clients that can set a Bearer header. Its `request_send` tool returns a Mailflare review URL; the MCP key cannot confirm or deliver messages directly. MCP does not require Workers AI for read and draft tools.

## Updating Mailflare

The **Update Mailflare** button in the admin dashboard dispatches `.github/workflows/deploy-update.yml` in the installation repository. The workflow replaces the installation branch's complete tracked tree with the latest upstream source, commits that replacement, and pushes it. This avoids merge conflicts between independently created installation and upstream histories. Target-only committed files and code changes are intentionally removed; repository variables, secrets, and other GitHub or Cloudflare configuration remain unchanged. A connected Cloudflare Git integration then builds and deploys the change.

### Auto update

Create a fine-grained personal access token for the installation repository with these repository permissions:

| Permission | Access | Used for |
| --- | --- | --- |
| Actions | Read and write | Dispatching `deploy-update.yml` from the Mailflare admin dashboard |
| Contents | Read and write | Committing and pushing the upstream source into the installation repository |
| Workflows | Read and write | Replacing files inside `.github/workflows` during an update |

Configure the token and repository details in both Cloudflare and GitHub:

| Location | Name | Type | Value |
| --- | --- | --- | --- |
| Cloudflare Worker | `GITHUB_UPDATE_TOKEN` | Secret | The fine-grained personal access token |
| Cloudflare Worker | `GITHUB_UPDATE_REPO` | Variable | The installation repository in `owner/repository` format |
| Cloudflare Worker | `GITHUB_UPDATE_REF` | Optional variable | The installation branch to update; omit it to use the repository's default branch |
| GitHub repository → Actions | `MAILFLARE_UPDATE_TOKEN` | Repository secret | The same fine-grained personal access token |
| GitHub repository → Actions | `UPDATE_SOURCE_REPOSITORY` | Optional repository variable | The upstream repository; defaults to `hieunc229/mailflare` |

The same token can be used for `GITHUB_UPDATE_TOKEN` and `MAILFLARE_UPDATE_TOKEN` when it has all three permissions above. Keep both values secret and limit the token's repository access to the installation repository.

Make sure `.github/workflows/deploy-update.yml` exists on the installation branch. If it is missing, create the file and copy its contents from the [canonical Mailflare update workflow](https://github.com/hieunc229/mailflare/blob/main/.github/workflows/deploy-update.yml). If an older installation has a different updater, replace it with the latest canonical workflow once. A running workflow cannot create or replace itself until the current workflow has been installed manually.

After the GitHub Action completes successfully, wait for the connected Cloudflare deployment to finish before refreshing Mailflare or applying pending database migrations. The workflow updates the repository first; the new application version is not live until Cloudflare completes its deployment.

Deployment and database migration are separate. After Cloudflare deploys a repository push or an admin-triggered update, open or refresh **Admin settings**. The application update card shows any pending database migrations. Select **Update database** to apply them through the Worker's D1 binding. The same runner initializes a new database during setup.

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

Each migration and its `d1_migrations` history entry run in one D1 batch. If a migration fails, its changes are rolled back, the failed filename is shown, and it can be retried after the problem is corrected. Wrangler remains available as a manual recovery tool.

New application releases must remain compatible with the previous schema until an administrator applies their migrations. Prefer additive changes, keep old columns during the transition, and avoid making authentication or the admin settings page depend immediately on a newly added column. Plan a maintenance window for an incompatible schema change.

When adding a schema change, create a new uniquely named SQL file in `drizzle/migrations` and do not edit an applied migration. Build and development commands generate the Worker migration bundle from those files. `npm run db:bundle` can generate it explicitly.

## Branding license

Activate a purchased Pro or Team key from **Admin → Licenses**. Mailflare sends the key to Paymug and stores only a one-way hash and the activation state. Apply all D1 migrations before activating a license.
