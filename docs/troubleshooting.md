# Troubleshooting

## Cloudflare error 9109: Invalid access token

The Deploy to Cloudflare flow can deploy the Worker, but its deployment token is not exposed to Mailflare at runtime. Create a separate Cloudflare API token and set it as `CF_TOKEN`.

Verify the token:

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer <CF_TOKEN>"
```

The response should report `success: true` and an active status. Check that:

- `CF_TOKEN` contains the token secret, not its ID.
- The value does not include the word `Bearer`.
- The token is currently valid and its IP restrictions allow the Worker.
- You redeployed after changing Cloudflare variables or secrets.

If you use a legacy Global API Key, set `CF_EMAIL` and `CF_API_KEY` instead of placing it in `CF_TOKEN`.

## Cloudflare error 10000 on Email Routing

Update the token so it can read the zone and manage its DNS, Email Routing settings, and Email Routing rules. The recommended scoped permissions are listed in the [deployment guide](deployment.md#required-configuration).

## Cloudflare error 2008 for existing MX records

Cloudflare Email Routing cannot be enabled while another mail provider's MX records are present. Mailflare shows a confirmation before replacing them. Continuing deletes the existing MX records and points incoming mail to Cloudflare Email Routing, so the previous provider will stop receiving mail. The `CF_TOKEN` needs **DNS Edit** permission for this action.

## Resend or SES domain stays "not verified"

The status is the provider's own, not Mailflare's. After the DNS records are added it can stay pending for several minutes (Resend and SES check public DNS, not Cloudflare's dashboard), and **Check status** re-asks the provider without creating anything. If one record stays stuck, look at the per-record statuses listed under the domain row, then check for a duplicate or older TXT record on the same name, a CNAME that is proxied through Cloudflare (it must be DNS only), or a record created at the wrong name (`send.example.com.example.com`). `dig TXT resend._domainkey.example.com +short` shows what the public sees.

## "This domain has MX records for another mail service"

Only one service can own a domain's MX records. Setting up a receiving provider shows the records it would replace and waits for your confirmation; confirming means the previous service stops receiving mail for that domain.

## Resend says the key can only send mail

A sending-only Resend key cannot add domains or webhooks. Replace it with a full-access key under the domain's Resend card, or add the domain in the Resend dashboard yourself (and, for receiving, create an `email.received` webhook pointing at `/api/inbound/resend`).

## SES receiving setup fails

- **Region.** SES receives mail only in some regions. Use one such as us-east-1, us-west-2 or eu-west-1.
- **Public address.** SNS must reach `/api/inbound/ses`, so `APP_URL` has to be a public HTTPS address; localhost does not work.
- **Permissions.** The AWS card lists the permissions the key lacks, with the IAM policy that grants them. Use **Re-check** after attaching it.
- **Sandbox.** An account in the SES sandbox can send only to verified addresses. Request production access in the SES console.
- **Subscription pending.** The SNS subscription confirms itself when SNS calls the endpoint; the checklist shows it as not ready until then. Use **Check again** after a minute.

## D1 error 7404: Database could not be found

D1 database IDs belong to a specific Cloudflare account. This error commonly means `wrangler.jsonc` contains an ID copied from another account.

For a reusable one-click deployment repository, remove the committed `database_id` and keep only `database_name`. Cloudflare can then provision the database in the target account.

For remote migrations after the first deployment:

1. Open the Worker's **Settings → Bindings** page in Cloudflare.
2. Open the `DB` D1 binding and copy its database ID.
3. Add that ID to your local `wrangler.jsonc`.
4. Run `npm run db:migrate:remote`.

Do not commit that account-specific ID to a reusable public repository.

## Scheduled backups are not running

Deploy the complete Worker with `npm run deploy`. A local Next.js server or a source-only update does not provision the cron trigger declared in `wrangler.jsonc`.

Also confirm that automatic backups are enabled under **Admin → Backups** and that the Worker has its `DB` and `BUCKET` bindings.

## Inbound mail is not arriving

Confirm that:

- The deployed Worker is named `mailflare`.
- `services[].service` in `wrangler.jsonc` is also `mailflare`.
- Email Routing is enabled for the domain in Cloudflare.
- The mailbox has an Email Routing rule pointing to the Worker.
- If the domain receives through Resend or Amazon SES instead, its receiving checklist is all green, the MX record points at that provider, and `APP_URL` is a public HTTPS address.

## The password-reset email never arrives

The reset form always answers success, so it cannot tell you why no mail was sent. Check the Worker logs for one of these lines:

- `Password reset skipped: account has no recovery email` — set the recovery email on the account first.
- `Password reset requested but no domain can send mail` — enable sending on a domain (Cloudflare, Resend or SES) with an active mailbox owned by an enabled user.
- `Password reset request failed` — the sending provider rejected the message; the error follows.
