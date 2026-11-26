# Security notes for inbound mail

## Deleted attachments stay in the original message

Deleting an attachment removes its stored file and its row, so it can no longer be
downloaded, previewed or shared. The message's original MIME (`rawR2Key`) is a faithful
copy of what arrived and is not rewritten, so **Download original** and the JMAP raw
blob still contain the attachment bytes. Delete the whole message to remove the original.

Public shared-file links stop working as soon as the message is moved to trash or spam
or its mailbox is disabled; they also expire on their own.

## Authentication results

* Cloudflare receiving: SPF, DKIM and DMARC come from the `Authentication-Results`
  header Cloudflare writes (authserv-id `mx.cloudflare.net`). A failure in any such clause
  wins over a pass.
* SES and Resend receiving: the provider's own verdicts are used.
* Self-hosted SMTP: the listener verifies SPF, DKIM and DMARC itself (with `mailauth`,
  using the connecting IP and the envelope sender) and feeds the results to the same
  policy. If DNS cannot answer within 10 seconds the mail carries no authentication
  signal and is delivered as before.

Sender-written `Authentication-Results`, `Received-SPF` and `Received` headers are never
trusted on the SMTP path. The listener also refuses recipients on domains Mailflare does not
manage before accepting DATA.

## Webhooks

Webhook URLs must be `https://` on a public host. Redirects are not followed, and hooks
saved before this rule are re-checked at delivery. Mail filed as spam or trash does not
trigger `message.inbound`. A webhook copies message content to the URL, so creating one, changing its URL, adding events or switching a disabled one back on needs the same fresh proof as other sensitive changes (step-up action `webhook.change`); existing webhooks keep working, and switching one off or rotating the secret needs none.

## Forwarding loop guard

Mail Mailflare forwards carries `X-Mailflare-Forwarded`, an HMAC keyed with a server secret
(`CF_TOKEN`, `CF_API_KEY` or `INBOUND_WEBHOOK_SECRET`). A sender cannot switch forwarding
off by adding the header. With none of those set the header falls back to `1`.

## Attachments

Mailflare does not run an antivirus engine. What it does instead:

* SES, and Resend (which receives through SES), drop mail the provider flagged as infected.
* Every attachment is judged from its name and type: programs and scripts, macro-enabled
  Office files, double extensions such as `invoice.pdf.exe`, hidden bidi characters, and
  containers that hide other files (HTML, SVG, disk images, archives).
* ZIP files are inspected without extracting anything: the file names in the central
  directory are read with two bounded range requests (at most 1000 entries and 1 MiB of
  directory). Password-protected or unreadable archives are flagged.
* A flagged attachment shows the reasons in the viewer, and the download stays disabled
  until the user ticks "I understand the risk". The server refuses an unacknowledged
  download of a flagged file with HTTP 409, so a direct link cannot bypass it.

This stops one-click downloads of things that are dangerous by design. It does not find
malware in an ordinary-looking PDF or image; put ClamAV or a provider scan in front of the
server if you need that.

## App passwords

An app password lets a mail or calendar app sign in without your account password and without a second step, so it is treated like any other security change:

- Creating one needs a fresh confirmation (password plus authenticator code, or a passkey) that is good for that action only and can be used once. The same confirmation is required to create an API key that carries the `jmap` scope (Settings > API keys), since that key signs in the same way.
- It is 16 random characters, stored only as a SHA-256 digest, and shown once. It is limited to the protocols you tick (today JMAP) and, for mail protocols, to the mailboxes you pick. It cannot call the `/api` endpoints or open the web app. The `jmap` scope is also accepted on `/api/mobile/push` and `/api/mobile/avatar` (the mobile app's endpoints), as a Bearer token or Basic password; those two routes do not apply the HTTPS check or the guess limit below.
- Protocols that sign in with HTTP Basic accept an app password only, never the account password, and, for the CalDAV/CardDAV and IMAP helper, only over HTTPS. JMAP's Basic path (any JMAP key sent as a Basic password) shares the guess limit but is still accepted over plain HTTP for compatibility with existing LAN and Docker clients; put it behind HTTPS (a TLS-terminating proxy with `TRUST_PROXY`) so the key is not sent in the clear. Bearer is not rate limited. Behind a reverse proxy on the Node server, set `TRUST_PROXY` so the proxy's `X-Forwarded-Proto: https` is believed. For that helper, plain HTTP is accepted only for local development: the request must come from the same machine and name `localhost`, `127.0.0.1` or `[::1]` in its `Host` header, so a proxy on the same machine without `TRUST_PROXY` is refused (unless it forwards `Host: localhost`; set `Host` to the public name or use `TRUST_PROXY`).
- Wrong guesses are rate limited: a secret the server has not verified recently spends a per-client budget (by IP address, IPv6 by /64) before it is looked up. A request with no known IP is limited per key being guessed rather than in one shared bucket. The limiter is the platform rate-limit binding, so without one configured (`DEVICE_LOGIN_RATE_LIMIT` or `LOGIN_RATE_LIMIT`) nothing limits guesses.
- Calendar and contacts sync (CalDAV and CardDAV, `/dav/*` and `/.well-known/caldav|carddav`) is off until an administrator turns it on under Admin > General; while it is off every one of those paths answers 404 and the "Calendar and contacts" choice is not offered when creating an app password. It accepts only app passwords with that choice ticked, only over HTTPS (plain HTTP gets 403 with a short explanation), and is served before the web framework with the same security headers as the app. Request bodies are capped (256 KiB for XML), and the XML parser refuses a DOCTYPE and processing instructions, so external entities and entity expansion are not possible. Wrong guesses share the per-IP limit above, and each app password is limited to 600 requests a minute (503 with `Retry-After`). This release answers discovery only (`OPTIONS` and `PROPFIND` for the root, principal and home sets); calendars and address books are not served yet.
- Settings > App passwords shows when each one was last used, over which protocol and from which IP address, and revokes it at once.
- Changing or resetting the password, changing two-step sign-in, an administrator resetting the account and "sign out everywhere" delete every app password, mobile device key and older JMAP-only key (keys created before app passwords existed whose only scope is `jmap`, the ones listed under App passwords). API keys that combine `jmap` with other scopes (send, read) are general API keys and are not revoked; revoke them under Settings > API keys.
