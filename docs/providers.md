# Sending and receiving providers

Mailflare keeps your mail data in your own D1 database and R2 bucket, Backblaze B2 or AWS S3 (or SQLite and local files when self-hosted). What carries mail over the wire is a choice you make **per domain**, separately for receiving and for sending:

| | Cloudflare | Resend | Amazon SES |
|---|---|---|---|
| **Receiving** | Email Routing (the default) | `email.received` webhook | S3 + SNS notification |
| **Sending** | Cloudflare Email Sending | Resend API | SESv2 API |

DNS stays on Cloudflare for every combination: Mailflare writes the records for whichever provider you pick. A domain can also be **receive-only** (sending: Not selected) or **send-only** (receiving: Not selected).

Open **Admin → Domains**, expand a domain, and use the **Setup receiving email** and **Setup sending email** sections. Each provider is a card with a switch. Turning a switch on selects that provider and shows its setup; the icon on the left is a green check when it is fully set up and an amber triangle when it is not.

> Selecting a provider does not change DNS. The Setup button inside the provider's card does. This lets you prepare a new provider while the old one keeps working.

## Choosing at add time

**New domain** asks which service receives the domain's mail (**Receive mail with**) and which sends it (**Send mail with**), each a dropdown of Cloudflare, Resend, Amazon SES or Not selected. Cloudflare Email Routing and the Cloudflare sending subdomain are only enabled on the zone for the Cloudflare choice. For Resend or SES the domain is added without touching either; finish from the domain page once the credentials are in. The same choices are available over the API as `receivingProvider` and `sendingProvider` (see [API](api.md#domain-management)).

## Resend

Resend uses one **API key**, shared by every domain that uses it. Create it at [resend.com/api-keys](https://resend.com/api-keys).

- A **full-access** key lets Mailflare add the domain to Resend, write its DNS records to the Cloudflare zone, verify it, and (for receiving) register the webhook.
- A **sending-only** key can send, but Resend refuses it for domain and webhook management, so you add the domain at [resend.com/domains](https://resend.com/domains), create its records yourself, and use **Send test email** to confirm. Mailflare says so in the card instead of failing.

The key is checked against Resend when you save it. It can also come from the `RESEND_API_KEY` secret, which is used when no key is saved in the app. Only the primary administrator can change it.

A service with a Resend-compatible API works the same way: set `RESEND_BASE_URL` to its API address and use its key. Every Resend call (sending, domains, webhooks, received mail) goes to that address.

**Sending.** Setup creates the domain in Resend, publishes its DKIM and SPF records, and asks Resend to verify. Verification is Resend's own status: it can stay `pending` for a few minutes after the DNS is added, and **Check status** re-asks Resend without creating anything new. Replies thread correctly because Mailflare sets its own `Message-ID`.

**Receiving.** Setup enables the receiving capability on the domain, points the apex MX at Resend, and registers one webhook for `email.received` at `/api/inbound/resend`. The webhook is authenticated with the Svix signing secret Resend returns when it is created; Mailflare stores that secret, which is why a webhook it did not create itself is replaced. For each event Mailflare fetches the message, downloads the raw MIME and runs it through the normal inbound pipeline. Resend must be able to reach your app, so `APP_URL` has to be a public HTTPS address.

## Amazon SES

Create an IAM user with programmatic access, then enter its **access key ID**, **secret access key** and **region** in the SES card. Mailflare validates them before saving: it proves the identity with STS, then makes a harmless call to each service it needs, and lists every permission the key lacks. Credentials can also come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`.

The key needs this policy (the card shows it too, with only the missing parts called out):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sts:GetCallerIdentity", "ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRuleSet", "ses:SetActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DescribeReceiptRule", "ses:DeleteReceiptRule"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["sns:ListTopics", "sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:CreateBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:ListBucket", "s3:GetObject", "s3:DeleteObject"], "Resource": "*" }
  ]
}
```

Only the sending statements are needed if you use SES just for sending.

**Sending.** Setup creates the domain's SES identity, publishes its three DKIM CNAME records to the Cloudflare zone, and tracks verification. New AWS accounts start in the **SES sandbox**, where SES delivers only to verified addresses; Mailflare shows a warning row until you request production access in the SES console. Replies thread because Mailflare stores the Message-ID SES assigns (`<id@email.amazonses.com>` in us-east-1, `<id@region.amazonses.com>` elsewhere).

**Receiving.** SES can only receive in some regions (for example us-east-1, us-west-2 and eu-west-1); Mailflare rejects the others. Setup creates, idempotently:

1. an S3 bucket (`mailflare-inbound-<account>-<region>`) that only SES may write to, with a one-day expiry for leftovers (best effort);
2. an SNS topic that only SES may publish to, subscribed to `/api/inbound/ses` with a secret token in the URL;
3. a receipt rule for the domain in the account's active rule set (Mailflare creates and activates `mailflare-inbound` only if the account has none, and otherwise adds its rule beside yours);
4. the MX record `inbound-smtp.<region>.amazonaws.com`.

Each message is read from your own bucket, handed to the normal inbound pipeline, and deleted. SES's virus scan is enabled and infected messages are dropped. `APP_URL` has to be a public HTTPS address so SNS can reach the endpoint. The bucket and topic are shared by all SES domains; **Clean up** removes only the domain's rule and MX, so Mailflare never deletes resources another domain may still use.

## MX records and switching receiving provider

Only one service can own a domain's MX records. When a provider's Setup finds MX records for something else (including Cloudflare Email Routing's), it stops and shows them, and replaces them only after you confirm. Confirming means the previous service stops receiving mail for that domain.

Per-address routes to the Mailflare Worker are only created for domains that receive through Cloudflare, and are recreated when you set Cloudflare up again.

## Cleaning up the provider you left

If a provider you are not using still has configuration for the domain, its card shows **Clean up**:

- **Cloudflare sending** deletes the zone's sending subdomain and its DNS.
- **Cloudflare receiving** deletes the domain's routing rules and MX, and disables Email Routing on the zone when no other domain uses it.
- **Resend** deletes the domain from Resend and its DNS records. If the domain still receives (or sends) through Resend, only the capability you are leaving is switched off.
- **SES sending** deletes the identity and its DKIM records.
- **SES receiving** deletes the domain's receipt rule and MX.

You cannot clean up the provider that is currently selected.

## Behavior that differs from Cloudflare

- **Routing rules.** Reject and forward rules need to act on the live SMTP session, which only Cloudflare's email handler can do. For mail received through Resend or SES, a reject rule drops the message and forward rules are not applied. Store and categorize rules, mailbox rules, spam handling and webhooks work as usual.
- **Attachments.** Cloudflare sends large files as download links from your storage bucket to stay under its 5 MiB limit. Resend and SES send attachments directly, within the administrator's outgoing limit (up to 25 MB).
- **Size.** Inbound mail from any provider is capped at 25 MiB and the same attachment limits apply; larger messages are dropped.

## Configuration reference

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend key used when none is saved in the app |
| `RESEND_BASE_URL` | Base URL of the Resend API (default `https://api.resend.com`); point it at a Resend-compatible service to send and receive through that instead |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | SES credentials used when none are saved in the app |
| `APP_URL` | Public HTTPS address; required for Resend and SES receiving, because the providers call this app |

Settings saved in the app take precedence over these variables. Keys saved in the app are stored as plain text in the `app_settings` table (as the AI provider key already is), so protect database backups accordingly.
