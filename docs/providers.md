# Sending and receiving providers

Mail data stays in your own D1 database and R2 bucket, Backblaze B2 or AWS S3 (or SQLite and local files when self-hosted). The wire provider is chosen **per domain**, separately for receiving and sending:

| | Cloudflare | Resend | Amazon SES |
|---|---|---|---|
| **Receiving** | Email Routing (the default) | `email.received` webhook | S3 + SNS notification |
| **Sending** | Cloudflare Email Sending | Resend API | SESv2 API |

DNS stays on Cloudflare for every combination; Mailflare writes the records for the chosen provider. A domain can be **receive-only** (sending: Not selected) or **send-only** (receiving: Not selected).

**Admin → Domains**, expand a domain, use **Setup receiving email** and **Setup sending email**. Each provider is a card with a switch: on selects it and shows its setup. Icon: green check = fully set up, amber triangle = not.

> Selecting a provider does not change DNS; the Setup button in its card does. This lets you prepare a new provider while the old one keeps working.

## Choosing at add time

**New domain** has **Receive mail with** and **Send mail with** dropdowns (Cloudflare, Resend, Amazon SES, Not selected). Cloudflare Email Routing and the Cloudflare sending subdomain are enabled on the zone only for the Cloudflare choice. For Resend or SES the domain is added without touching either; finish from the domain page once credentials are in. API equivalents: `receivingProvider` and `sendingProvider` (see [API](api.md#domain-management)).

## Resend

One **API key**, shared by every Resend domain. Create it at [resend.com/api-keys](https://resend.com/api-keys).

- A **full-access** key lets Mailflare add the domain to Resend, write its DNS records to the Cloudflare zone, verify it, and (for receiving) register the webhook.
- A **sending-only** key can send, but Resend refuses it for domain and webhook management: add the domain at [resend.com/domains](https://resend.com/domains), create its records yourself, and confirm with **Send test email**. The card says so instead of failing.

The key is checked against Resend on save. `RESEND_API_KEY` takes priority over a saved key. Only the primary administrator can change it.

A Resend-compatible service works the same way: set `RESEND_BASE_URL` to its API address and use its key. Every Resend call (sending, domains, webhooks, received mail) goes there. If the service refuses a custom `Message-ID` header, set `RESEND_CUSTOM_MESSAGE_ID=false`: Mailflare then sends without it and threads replies on the Message-ID the service reports for the sent email (`message_id` from `GET /emails/{id}`), falling back to its own when none is reported yet. If it refuses other headers Mailflare sets, such as `Auto-Submitted` on system mail and auto-replies, list them in `RESEND_OMIT_HEADERS` (comma-separated) and they are left out of every send.

**Sending.** Setup creates the domain in Resend, publishes its DKIM and SPF records, and asks Resend to verify. Verification is Resend's own status: it can stay `pending` for a few minutes after the DNS is added, and **Check status** re-asks Resend without creating anything new. Replies thread correctly because Mailflare sets its own `Message-ID`.

**Receiving.** Setup enables the receiving capability on the domain, points the apex MX at Resend, and registers one webhook for `email.received` at `/api/inbound/resend`. The webhook is authenticated with the Svix signing secret Resend returns when it is created; Mailflare stores that secret, which is why a webhook it did not create itself is replaced. For each event Mailflare fetches the message, downloads the raw MIME and runs it through the normal inbound pipeline. Resend must be able to reach your app, so `APP_URL` has to be a public HTTPS address.

## Amazon SES

Create an IAM user with programmatic access; enter its **access key ID**, **secret access key** and **region** in the SES card. Validation before saving: identity via STS, then a harmless call to each needed service; every missing permission is listed. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` take priority over saved ones.

Required policy (the card shows it too, calling out only the missing parts):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sts:GetCallerIdentity", "ses:GetAccount", "ses:SendEmail", "ses:CreateEmailIdentity", "ses:GetEmailIdentity", "ses:DeleteEmailIdentity", "ses:SetIdentityNotificationTopic"], "Resource": "*" },
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

## Bounces and complaints

Resend and SES can report permanent bounces and spam complaints back; Mailflare keeps a per-domain suppression list. Off by default; see [deliverability.md](deliverability.md).

## MX records and switching receiving provider

Only one service can own a domain's MX records. When a provider's Setup finds MX records for something else (including Cloudflare Email Routing's), it stops and shows them, and replaces them only after you confirm. Confirming means the previous service stops receiving mail for that domain.

Per-address routes to the Mailflare Worker exist only for domains receiving through Cloudflare, and are recreated when Cloudflare is set up again.

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
- **Attachments.** Cloudflare sends large files as download links from your storage bucket to stay under its 5 MiB limit. Resend and SES send attachments directly, within the administrator's outgoing limit; past 20 MB they too go as download links, which keeps the encoded message under what most receiving servers accept (the limit can be raised to 50 MB on Node/Docker; Workers stay at 25 MB).
- **Size.** Inbound mail from any provider is capped at 25 MiB and the same attachment limits apply; larger messages are dropped.

## Configuration reference

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend key; overrides one saved in the app |
| `RESEND_BASE_URL` | Base URL of the Resend API (default `https://api.resend.com`); point it at a Resend-compatible service to send and receive through that instead |
| `RESEND_CUSTOM_MESSAGE_ID` | `false` stops sending Mailflare's own `Message-ID` header, for compatible services that refuse it (default: sent) |
| `RESEND_OMIT_HEADERS` | Comma-separated headers left out of every Resend send, for compatible services that refuse them (default: none) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | SES credentials; override ones saved in the app |
| `APP_URL` | Public HTTPS address; required for Resend and SES receiving, because the providers call this app |

Environment variables take precedence over saved settings; the saved value is used only when the variable is unset. Keys saved in the app are stored as plain text in the `app_settings` table (as the AI provider key already is): protect database backups accordingly.
