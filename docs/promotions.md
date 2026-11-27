# Promotions and Subscriptions

Separates bulk marketing mail from person-to-person mail. Off for every mailbox until enabled; when off, nothing about the mailbox changes.

## Turning it on

**Settings → Inbox → Promotions** has one choice per mailbox you fully manage:

| Mode | Inbox | Promotions page | Push and browser notifications for a promotion |
| --- | --- | --- | --- |
| Off (default) | Unchanged | Hidden | Unchanged |
| Show Promotions | Unchanged, promotions carry a "Promotion" chip | Shown | Unchanged |
| Move promotions out of Inbox | Promotions hidden | Shown, with an unread count | Not sent (open windows still refresh) |

People with read-only or send-only access to a shared mailbox see its mode but cannot change it, and cannot move, override or trash mail.

First enable sorts the last 90 days of mail in the background (25 messages every 5 minutes, at most 2,000 a day across the installation). Settings shows progress; a large mailbox takes several days. If the job stalls three times in a row it stops and Settings shows the error with **Try again**.

## How mail is classified

Each new message is classified once when it arrives, from its headers: `List-Unsubscribe`, `List-Id`, `Precedence`, `Feedback-ID` and known sending-service fingerprints (see `src/lib/email/bulk-mail.ts`). Discussion lists and receipts are not promotions, and neither is mail from people you have written to. Your own choices always win over headers.

- **Move to Promotions / Move to Inbox** on a message sets that message. A toast then offers **Always for <sender>**. Moving to Inbox is remembered, so the background sorting never moves that message back.
- A sender choice re-files that sender's received, unfiled mail from the **last 90 days, at most 500 messages per request**. The result says how many moved and how many were left unchanged (older than 90 days, or beyond the 500 limit). Choosing again continues.
- Search: `category:promotions`, `category:primary`.
- Webhooks: `message.inbound` gains a `category` field (`"promotions"` or `null`).
- JMAP: promotions carry the read-only keyword `$promotion`, which can be filtered with `hasKeyword` and `notKeyword`, in mailboxes where Promotions is on; with it off, JMAP is exactly as it was. The JMAP Inbox always contains promotions, whatever the mode.

## Subscriptions

**Subscriptions** (under More, and linked from Settings) lists the senders of promotions from the last 90 days: messages, last received, read rate, and whether you unsubscribed. Spam and Trash are not counted.

- **Unsubscribe** uses the same one-click, email or web-page flow as the message reader.
- **Unsubscribe and trash** unsubscribes, then moves that sender's mail to Trash.
- **Block** adds a rule that sends mail from the address to Trash.
- **Trash all** moves that exact sender's unstarred, unfiled mail from the last 90 days to Trash, at most 500 messages per request. You see a count first, and the result says how many moved and how many were left. Mail you moved to Trash stays there for the usual retention period.

## Database write budget

D1 Free allows 100,000 row writes a day. Each promoted message costs about 6 writes: the row, its indexes and the change-log entry. The background sort therefore reads at most 25 messages per run and 2,000 a day for the whole installation, regardless of mailbox count: 2,000 x 6 = 12,000 writes, about an eighth of the allowance, so mail arriving that day keeps its room. The day is the UTC day, counted in `mailbox_promotion_settings.backfill_day` and `backfill_day_rows`. When the allowance is used up, jobs stay queued and continue after midnight UTC. Move to Promotions and Trash all are capped at 500 messages per request for the same reason (each moved message writes change-log rows).

## Upgrading

Needs the pending database migrations. Until applied, every mailbox behaves as Off and the settings route answers `MIGRATION_REQUIRED`.
