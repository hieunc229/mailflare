# Bounce and complaint suppression list

Mailflare can remember addresses that bounced permanently or reported your mail as spam, per sending domain, and optionally stop sending to them. It is **off by default**, on upgrades and on new installations. Nothing changes until the primary administrator picks a mode under **Admin → Email → Deliverability**.

## Modes

| Mode | Provider events and returned bounces | Sending |
|---|---|---|
| Off (default) | Verified, answered `200`, not recorded (no replay marker is written either). Returned messages are not parsed. | Unchanged |
| Record only | Stored in the list | Unchanged |
| Skip suppressed recipients | Stored in the list | Refused or filtered, see below |

The mode applies to the whole installation. The list itself is per sending domain: a complaint about mail from `a.example` does not block the same person on `b.example`.

## Where events come from

- **Resend**: a second webhook, separate from the receiving one, for `email.bounced` and `email.complained`, posting to `/api/provider-events/resend`. It has its own Svix signing secret. Soft bounces (`bounce.type` `Temporary` or `Transient`) are ignored; a bounce without a type counts as permanent. Resend's payload lists every recipient of the message (`to`) but does not say which one bounced or complained: with one recipient the entry is enforced, with several they are stored **unconfirmed** (see below). Needs a full-access API key and a public HTTPS `APP_URL`.
- **Amazon SES**: one SNS topic (`mailflare-feedback`) subscribed to `/api/provider-events/ses?token=…`. Mailflare points the Bounce and Complaint notifications of every SES sending domain at it (`ses:SetIdentityNotificationTopic` is part of the IAM policy shown in the SES card). Only permanent bounces and complaints count. The URL token, the topic ARN and the SNS signature are all checked.
- **Returned bounce messages** (Cloudflare and self-hosted sending, which have no event feed): a delivery status notification that reaches a mailbox is read only if it names a `Message-ID` of a message sent from that mailbox in the last 30 days, and only for recipients that message was addressed to (To, Cc, Bcc). The message itself stays in the mailbox. At most 50 distinct addresses are taken from one message.

  A returned message alone is **not enforced**. A co-recipient of a message you sent knows its `Message-ID` and the other addresses, so it can forge a bounce for them. These entries are stored **unconfirmed** and start to count once a second returned message names the same address for a *different* original message, or an administrator confirms the entry. A person who received two of your messages could still forge both, so use this source as a hint and review the list.

Connect or disconnect Resend and SES on the Deliverability page. Providers retry unacknowledged events, so with the mode off the endpoints still answer `200`.

## What "skip suppressed recipients" does

- The composer and `POST /api/send` / `POST /api/v1/send` answer `422` with `{ "code": "SUPPRESSED_RECIPIENT", "addresses": [...] }` before anything is stored.
- JMAP `EmailSubmission/set` returns `notCreated` with type `invalidRecipients`.
- Scheduled and undo-send messages are checked again at delivery. Suppressed recipients are dropped and the drop is written to the audit log (`email.suppressed_recipients_dropped`). If no To recipient is left the message fails.
- Calendar invitations created with `POST /api/calendar/events` are checked before the event is saved and answer the same `422`, so a refused invitation leaves nothing behind and a retry creates no duplicate.
- Auto-replies to a suppressed address are skipped.
- Only **confirmed** entries are enforced; unconfirmed ones (see below) never block a send.
- The stored message keeps every recipient you wrote (history). Recipients dropped at delivery appear only in the `email.suppressed_recipients_dropped` audit entry, with the addresses in its metadata.
- System mail (password reset and similar) is not affected.

## Managing the list

The Deliverability page lists a domain's entries (address, reason, source, event count, last event), with search and a reason filter. **Remove** deletes an entry, after which the next message to that address is attempted again; removals are audit-logged (`deliverability.suppression_removed`). If the same address bounces again it returns to the list.

Unconfirmed entries show an **Unconfirmed** badge. **Confirm** makes one enforceable (audit-logged as `deliverability.suppression_confirmed`); **Remove** deletes it. Entries from signed provider events (SES, Resend with one recipient) and manual entries are confirmed from the start, and a later confirmed event confirms an unconfirmed entry. An unconfirmed event never changes an entry that is already confirmed.

An address that complained stays a complaint; a later bounce does not downgrade it.

## Data

Table `email_suppressions` (address, reason, source, `confirmed`, the `Message-ID` that first reported it (`evidence_ref`, used to tell a second DSN from a repeat of the first), a diagnostic text truncated to 300 characters, counters and times). It is included in backups and restores before its migration is applied. The settings live in four `app_settings` columns: `suppression_mode`, `resend_events_webhook_id`, `resend_events_webhook_secret` and `ses_feedback`. As with the other provider secrets, the Resend signing secret is stored in plain text in `app_settings`, so protect backups.
