# API and integrations

Mailflare exposes APIs for domain, account, and mailbox management, and for sending email. Authentication and mailbox permissions still apply to these routes.

## Domain management

Adding or removing a domain from Mailflare also updates Cloudflare Email Routing and sending resources. Each domain has a `sendingProvider` and a `receivingProvider` (`none`, `cloudflare`, `resend` or `ses`); see [Sending and receiving providers](providers.md).

| Mailflare route | Purpose |
| --- | --- |
| `GET /api/domains` | List connected domains |
| `POST /api/domains` | Connect a domain and configure Cloudflare |
| `GET /api/domains/[id]` | Get a connected domain |
| `DELETE /api/domains/[id]` | Remove a domain and clean up its Cloudflare resources |
| `GET /api/domains/[id]/dns` | View its routing and sending DNS status |
| `PUT /api/domains/[id]/sending` | Choose the sending provider (`{ provider: "none" \| "cloudflare" \| "resend" \| "ses" }`) |
| `PUT /api/domains/[id]/receiving` | Choose the receiving provider (same values) |
| `GET /api/domains/[id]/sending`, `GET /api/domains/[id]/receiving` | Which providers still have configuration for the domain |
| `DELETE /api/domains/[id]/sending`, `DELETE /api/domains/[id]/receiving` | Remove an unselected provider's configuration (`{ target }`) |
| `GET/POST /api/domains/[id]/resend`, `/api/domains/[id]/ses` | Sending status, setup, verify and test email for Resend or SES |
| `GET/POST /api/domains/[id]/receiving/[provider]` | Receiving checklist and setup for `resend` or `ses`; `POST` also accepts `cloudflare`, and answers `409 MX_CONFLICT` with the records until called with `{ replaceMx: true }` |
| `GET/PUT/DELETE /api/admin/resend-key` | The shared Resend API key (primary administrator) |
| `GET/PUT/POST/DELETE /api/admin/aws` | The shared AWS credentials: `PUT` validates before saving and `POST` re-checks permissions (primary administrator) |

The hostname must be the apex of a zone available to the configured Cloudflare credentials, or a subdomain of that zone. Creating a mailbox also creates the Cloudflare Email Routing rule that delivers its address to the `mailflare` Worker.

### Domain management over the API

The same operations are available to scripts through admin API keys with the `domains` scope, using `Authorization: Bearer <key>`. Create these keys in Admin > API keys. The owner must retain the admin role; personal mail keys from Settings cannot grant domain access.

| Mailflare route | Purpose |
| --- | --- |
| `GET /api/v1/domains` | List connected domains with their DNS status |
| `POST /api/v1/domains` | Connect a domain and configure Cloudflare (`{ hostname, enableRouting?, enableSending?, replaceMxRecords?, receivingProvider?, sendingProvider? }`; `receivingProvider` defaults to `cloudflare`, and with another value Email Routing is not enabled. `sendingProvider` defaults to `cloudflare` (or `none` when `enableSending` is `false`), and the Cloudflare sending subdomain is only created for `cloudflare`) |
| `GET /api/v1/domains/[id]` | Get a connected domain |
| `DELETE /api/v1/domains/[id]` | Remove a domain and clean up its Cloudflare resources |
| `GET /api/v1/domains/[id]/dns` | View its routing, sending and authentication DNS status |
| `POST /api/v1/domains/[id]/dns/setup` | Create a missing record (`{ record: "mx" \| "spf" \| "dkim" \| "dmarc" }`) |

`GET /api/v1/domains` returns `{ domains, dns }`, where `dns[id].auth` reports `ok` / `missing` / `unknown` for MX, SPF, DKIM and DMARC. `GET /api/v1/domains/[id]/dns` returns the full audit, including the names queried and the values found. The `setup` route provisions MX/SPF through Email Routing, DKIM through the sending subdomain, and a `v=DMARC1; p=none` TXT for DMARC; on a self-hosted install where DNS is managed manually it returns an error, since Mailflare cannot write the zone.

### Inbound provider endpoints

Resend and Amazon SES deliver mail by calling the app, so these routes are public and authenticate themselves rather than using a session or API key:

| Route | Authenticated by |
| --- | --- |
| `POST /api/inbound/resend` | The Svix signature of the webhook secret Resend returned when Mailflare created the webhook |
| `POST /api/inbound/ses?token=…` | The secret token in the subscription URL, the SNS topic ARN, and reading the message from the account's own S3 bucket |
| `POST /api/inbound` | The HMAC from the Cloudflare relay Worker, used by self-hosted installs ([self-hosting](self-hosting.md)) |

## Calendar and booking

### Calendar

Each user has a personal calendar at **Calendar** in the dashboard. Events have a title, description, location, attendees, color, time zone and an optional repeat (`daily`, `weekly`, `monthly` or `weekdays`, with an end date and skipped occurrences). Changing or deleting a repeating event affects the whole series unless you choose a starting occurrence.

When you add attendees and choose a sending mailbox, Mailflare emails each attendee an invitation with a calendar (`.ics`) file from that mailbox, and sends updates and cancellations the same way. Events created through MCP tools or the assistant record attendees but do not send invitations.

| Mailflare route | Purpose |
| --- | --- |
| `GET /api/calendar/events?start=&end=` | List events in an ISO 8601 range (default: the next 31 days). Repeating events are returned once, with their rule |
| `POST /api/calendar/events` | Create an event (`{ title, startsAt, endsAt, description?, location?, attendees?, color?, repeat?, repeatDays?, timeZone?, mailboxId?, from? }`) |
| `PATCH /api/calendar/events/[eventId]` | Update an event or series. For a repeating event, pass an occurrence ID or `effectiveFrom` to change it from that occurrence onward |
| `DELETE /api/calendar/events/[eventId]` | Delete an event, or a series from an occurrence onward |

These routes accept the dashboard session or an API key (`Authorization: Bearer <key>`) with the **Read calendar** (`calendar:read`) or **Manage calendar** (`calendar:write`) scope, which you choose when creating the key in **Settings → API keys**. A key can only send invitations if it also has the `send` scope for the chosen mailbox. MCP and the assistant use separate calendar tools, described in [Email assistant and MCP](email-assistant-and-mcp.md).

### Booking pages

Open **Booking** to create booking events: a name, link (slug), duration, location, weekdays, one or more daily time ranges, a time zone and an on/off switch. Two disabled templates (15 and 30 minute meetings) are offered to start from. Each user gets a booking username, derived from their email and unique across the instance; an administrator can change it. Booking events are served at `/book/<username>` (the list) and `/book/<username>/<event>` (one event), with no login.

A guest picks a slot, enters a name, email, optional extra guest emails and notes, and the booking is added to the host's calendar with the guest as attendee. Slots come from the host's availability: every 15 minutes inside the allowed ranges, up to 60 days ahead, at least an hour from now, and only where the host's calendar is free, repeating events included. The booking is inserted in one statement that re-checks for conflicts, so two guests cannot take the same slot. Mailflare does not email the guest a confirmation; the booking page confirms on screen.

On a Team license an administrator can add other users as hosts of a booking event. The booking is created on every host's calendar, and a slot is offered only when all hosts are free.

| Mailflare route | Purpose |
| --- | --- |
| `GET /api/booking`, `POST /api/booking` | List or create the signed-in user's booking events |
| `PATCH /api/booking/[eventId]`, `DELETE /api/booking/[eventId]` | Update or delete one |
| `PATCH /api/booking/settings` | Change the booking username (administrators) |
| `GET /api/public/booking?username=` | Public: the host's name and enabled events |
| `GET /api/public/booking/[eventId]?username=` | Public: one event and its open slots |
| `POST /api/public/booking/[eventId]?username=` | Public: book a slot (`{ name, email, startsAt, guestEmails?, notes? }`) |

## Account and mailbox management

Admin > API keys can also grant the `accounts`, `mailboxes` and `storage` scopes independently. These routes use `Authorization: Bearer <key>` and require the key owner to retain the admin role. Account management requires a Team license; creating a shared mailbox also requires a Team license. Each key can access only accounts created by its owner and mailboxes owned by those accounts or the admin.

The `storage` scope reports and tests object storage: `GET /api/v1/storage` returns `{ storage: { provider: "backblaze" | "s3" | "r2" | "files", configured, bucket, endpoint }, warning }` (credentials are never returned; `warning` explains a half-set `B2_*` configuration), and `POST /api/v1/storage` round-trips a small object and returns `{ ok, error?, latencyMs, storage }` (HTTP 502 on failure). Backblaze B2 (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`) or AWS S3 (`S3_BUCKET`, `S3_REGION`, credentials) replaces R2 for all stored objects when configured.

Admin API keys cannot read or send mail. Enable **Allow MCP access** when creating an admin key to use its selected `domains`, `accounts`, `mailboxes`, and `storage` permissions through `/mcp`. The `manage_domains`, `manage_accounts`, `manage_mailboxes`, and `manage_storage` (`status`, `test`) tools expose the corresponding management actions below. Admin MCP keys do not expose mail tools. Use Settings > API keys for mail and mail MCP access.

| Scope | Mailflare route | Purpose |
| --- | --- | --- |
| `accounts` | `GET /api/v1/accounts` | List managed accounts |
| `accounts` | `POST /api/v1/accounts` | Create an account and its mailbox (`{ username, domainId, password, role?, useAllDomains?, aliases? }`) |
| `accounts` | `GET /api/v1/accounts/[id]` | Get a managed account |
| `accounts` | `PATCH /api/v1/accounts/[id]` | Update an account (`{ name, role, disabled, canManageMailboxes, forwardingEmail?, password? }`) |
| `mailboxes` | `GET /api/v1/mailboxes` | List managed mailboxes |
| `mailboxes` | `POST /api/v1/mailboxes` | Create a mailbox (`{ domainId, localPart, displayName?, type?, ownerUserId? }`) |
| `mailboxes` | `GET /api/v1/mailboxes/[id]` | Get a managed mailbox |
| `mailboxes` | `PATCH /api/v1/mailboxes/[id]` | Update mailbox settings |
| `mailboxes` | `DELETE /api/v1/mailboxes/[id]` | Delete a mailbox and its routing rule |
| `storage` | `GET /api/v1/storage` | Active object storage (R2, Backblaze B2, AWS S3 or local files) |
| `storage` | `POST /api/v1/storage` | Write, read and delete a test object to verify storage |

### Choose aliases when creating an account

In **Admin > Accounts > New account**, the primary address is assigned by default.
Add optional aliases by choosing each username and domain, or enable **Use all domains**
to also receive and send as the primary username on every available active domain owned
by the same admin, including domains added later.

The dashboard, admin API, and MCP `manage_accounts` create action share the same
creation handler. For example, this API body creates `sam@example.com` with just
`sales@example.net` as an additional alias:

```json
{
  "username": "sam",
  "domainId": "dom_example_com",
  "password": "REPLACE_WITH_A_STRONG_PASSWORD",
  "useAllDomains": false,
  "aliases": [
    { "domainId": "dom_example_net", "localPart": "sales" }
  ]
}
```

Pass the same object as `data` to `manage_accounts` with `action: "create"`.
`aliases` defaults to an empty list. Alias domains must
be active and owned by the admin creating the account. Duplicate addresses and conflicts
with existing mailboxes or aliases are rejected, including equivalent dot/plus variants.
An alias shares its mailbox's delivery, message storage, and sending permissions.

For backward compatibility, API/MCP requests that omit `useAllDomains` still default
to `true`; pass `false` explicitly for primary-only or selected-alias accounts. The
dashboard sends `false` unless the checkbox is enabled. This changes initial address
assignment, not existing mailbox management permissions. Existing accounts are not
modified and no database migration is required.

Creation validates all selected addresses before provisioning. Account, mailbox, and
alias records are inserted atomically. If Cloudflare routing fails, the new records
are removed and routing changes from that attempt are rolled back, preserving existing
rules. If cleanup itself fails, the response reports that manual checking is needed.

## Sending email

Send email through `POST /api/v1/send`. `to`, `cc` and `bcc` accept either a comma-separated header string or an array of addresses; each entry may carry a display name (`"Maya Chen" <maya@example.net>`). A message can reach up to 50 recipients across the three fields. Attachments are optional and use Base64-encoded content:

```json
{
  "from": "support@example.com",
  "to": ["user@example.net", "\"Maya Chen\" <maya@example.net>"],
  "cc": "ops@example.com",
  "bcc": ["audit@example.com"],
  "subject": "Report",
  "text": "Attached.",
  "attachments": [
    {
      "filename": "report.pdf",
      "type": "application/pdf",
      "contentBase64": "<base64 data>"
    }
  ]
}
```

To send a reply that threads correctly in the recipient's client, pass the parent's Message-ID as `inReplyTo` and its chain as `references` (a header string or an array). Mailflare writes the `In-Reply-To` and `References` headers, files the sent copy in the same conversation, and stores `threadId`, `inReplyTo` and `references` on every message.

```json
{
  "from": "support@example.com",
  "to": "user@example.net",
  "subject": "Re: Report",
  "text": "Thanks, received.",
  "inReplyTo": "<CAF1abc@mail.example.net>",
  "references": ["<CAF0root@mail.example.net>", "<CAF1abc@mail.example.net>"]
}
```

`GET /api/messages/{id}/thread` (session auth) returns every stored message in the same conversation, oldest first, excluding drafts and trash. The same response includes `note`, the one note on that conversation, or `null`. `PUT /api/messages/{id}/note` with `{ body }` saves it and `DELETE` clears it. Anyone who can read the mailbox can see it. Reply, forward, search, and JMAP do not include it, and it is never sent. `GET /api/messages?group=thread` collapses a list to one row per conversation (its newest message matching the filter) and adds `threadCount`, `threadUnread` and `threadMessageIds`, the ids that row stands for within the current filter, so bulk actions can act on the whole conversation.

`POST /api/messages/bulk` (session auth) with `action: "delete"` permanently removes the given messages, including their raw MIME and attachment objects, but only those already in Trash or Spam; others are skipped and counted in `skipped`. `POST /api/messages/empty` with `{ mailboxId, folder: "trash" | "spam" }` permanently deletes that folder's messages in batches of 100 and returns `{ deleted, remaining }`; call it again until `remaining` is 0. Both write an `email.delete` audit entry per message with `permanent: true`.

Each user can also choose **Settings > Inbox > Trash and Spam clean-up** to delete Trash and Spam automatically after a number of days (`GET`/`PATCH /api/settings/trash-retention` with `{ days: number | null }`, 1 to 365, `null` for never). It applies to messages in mailboxes the user owns. `messages.trashed_at` records when a message entered either folder; database triggers keep it current, and the scheduled maintenance run deletes expired messages in batches of 200, with `source: "retention"` in the audit entry.

Messages composed in Mailflare are sent as HTML with a plain-text alternative derived from it. Quoted or forwarded content is wrapped in `<div class="mailflare-quote" data-mailflare-quote="1">` so the reader can fold it. `POST /api/drafts` accepts `forwardOfMessageId`, which copies that message's attachments onto the new draft; `DELETE /api/drafts/{id}/attachments/{attachmentId}` removes one, and `POST /api/send` with `draftId` sends the draft's stored files along with any uploaded in the request.

The dashboard composer accepts up to 10 attachments. An administrator sets the outgoing per-file and combined limit from 1 to 25 MB on **General** (`/general`); the default is 25 MB. Attachment metadata is stored in D1 and file content is stored in R2. Normal message downloads require access to the mailbox containing the message.
The limits below apply to domains that send through Cloudflare. Resend and Amazon SES take attachments directly, within the same administrator limit. Cloudflare Email Sending limits the entire encoded message, including attachments, to 5 MiB for general recipients, or 25 MiB for verified destination addresses. To stay under the general limit, files over 3 MB and smaller files that would exceed the message budget are sent as R2 download links. The recipient can download them for 30 days; anyone with the link can access the file during that time. The outgoing cap still applies to those files. Cloudflare also limits recipient count to 50, subject length to 998 characters, and headers to 16 KB.
Incoming mail that exceeds the attachment count or 25 MB decoded attachment limit is rejected during delivery, so the sender's mail provider can report a delivery failure. Cloudflare Email Routing also limits the entire raw message to 25 MiB, including MIME encoding, and may reject it before Mailflare runs.

## JMAP

Mailflare serves [JMAP](https://jmap.io) (RFC 8620 core and RFC 8621 mail, plus submission) so external mail apps can read and send mail. Discovery is at `/.well-known/jmap`, which redirects to `/jmap/session`. Authenticate with an API key that has the `jmap` scope, either as `Authorization: Bearer <key>` or as the password of HTTP Basic auth (the username is ignored). Settings > Account > App passwords mints such a key.

The account id is the user id. Each Mailflare mailbox appears as a top-level JMAP Mailbox with system children (`inbox`, `drafts`, `sent`, `archive`, `junk`, `trash`) and one child per user folder; a message belongs to exactly one of them. Supported methods: `Mailbox/get|query|set` (folders only), `Thread/get`, `Email/get|query|set|import`, `SearchSnippet/get`, `Identity/get`, `EmailSubmission/set`, and `Core/echo`. `Email/copy` and `Email/parse` are not implemented. `*/changes` return `cannotCalculateChanges`, so clients re-query on a state change; `/jmap/eventsource` pushes state changes by polling. `Email/set` creates drafts, updates `$seen` and `$flagged`, moves between mailboxes, and destroys (to Trash first, then permanently). `EmailSubmission/set` sends a draft and reports it destroyed, since the sent copy is a new message. Blob download and upload follow the Session's `downloadUrl` and `uploadUrl`.

`Email/import` takes a `message/rfc822` blob that was uploaded first and stores it as a draft, which is how clients that compose MIME themselves send: upload, import, then `EmailSubmission/set`. Each entry takes `blobId`, `mailboxIds`, and optionally `keywords` and `receivedAt`. **The target must be exactly one Drafts mailbox** — importing into Inbox or a folder is rejected with `invalidProperties` on `mailboxIds`, because delivered mail belongs to the inbound pipeline that does threading and spam scoring. `$seen` and `$flagged` are stored, `$draft` is implied, and other keywords are ignored. `receivedAt` sets the message date, falling back to the `Date` header and then to now. The uploaded bytes are kept verbatim, so downloading the new message's `blobId` returns exactly what was uploaded rather than a reconstruction, and the `Message-ID` header is stored so the client can find its own draft again. Per-message failures come back in `notCreated` as `blobNotFound`, `invalidEmail`, `invalidProperties`, `forbidden` (the `From` address is not one the key may send from) or `tooLarge`.

`Email/query` supports the `header` filter: `["Message-ID", "<id@example.com>"]` matches messages with that value, and `["Message-ID"]` matches any message that has the header. `Message-ID`, `In-Reply-To` and `References` are answered from stored columns; Message-IDs compare with or without angle brackets, and header names are case-insensitive. Any other header name returns an `unsupportedFilter` error rather than silently matching everything.

## Password reset and two-factor authentication

`POST /api/auth/password-reset/request` with `{ email }` always answers `200 { ok: true }`; when the account exists and has a recovery email, a single-use link valid for 30 minutes is mailed there. `POST /api/auth/password-reset/confirm` with `{ token, password }` sets the password and signs the account out everywhere.

When two-factor authentication is on, `POST /api/auth/login` returns `{ ok: true, mfaRequired: true, challengeToken }` instead of a session. `POST /api/auth/mfa/verify` with `{ challengeToken, code }` completes the sign-in; `code` is a 6-digit TOTP or one of the recovery codes. Challenges expire after 5 minutes. Enrolment, recovery codes and turning it off are under `/api/settings/mfa/*` (session auth) and always re-check the password.

## Searching

`GET /api/messages?q=...` (session) and `GET /api/v1/messages?q=...` (API key, `read` scope) accept the same query grammar, backed by an FTS5 index over subject, sender, recipients and body:

| Syntax | Meaning |
|---|---|
| `invoice` | prefix match anywhere (`inv` finds "invoice") |
| `"private window"` | exact phrase |
| `-word` | exclude |
| `from:maya`, `to:sam`, `subject:report` | restrict a term to one field (`to:` covers Cc) |
| `has:attachment` | at least one non-inline attachment |
| `is:unread`, `is:read`, `is:starred` | flags |
| `after:2026-09-01`, `before:2026-09-30` | date bounds (UTC, `before` exclusive) |

Terms combine with AND. Notes are not in this index, so a word that appears only in a note is not a hit. Admins can check or rebuild the index with `GET` / `POST /api/admin/search-index`; triggers keep it current, so a rebuild is only needed after restoring a backup made before the index existed.

## Real-time updates

Mailflare uses a Durable Object WebSocket hub to notify connected users after an inbound message is stored. Mailbox owners, the domain administrator, and delegated users receive events for mailboxes they can access.

The `REALTIME` binding and its migration are declared in `wrangler.jsonc`. When a WebSocket is temporarily unavailable, the app retries the connection and uses a slower refresh until it recovers.
