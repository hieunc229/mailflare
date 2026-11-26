# Groups

A group is an address such as `team@example.com` that delivers a copy of every message to each of its members. Use it for `sales@`, `billing@` or `team@` addresses that several people read. Each member gets the message in their own inbox, so nobody shares a mailbox.

Groups need a Pro or Team licence (the same one that unlocks accounts). Without it the **Groups** page shows an upgrade card, the API answers `403` with `code: "LICENSE_REQUIRED"`, and mail to an existing group address is treated as if the address did not exist.

## Manage groups

Open **Admin → Groups**. You need the permission to manage users, and you can only use domains you can already use for mailboxes.

- **Create.** Pick a domain, a local part, a name, and who can send to the group. The address cannot be one that a mailbox, alias or another group already uses (dots and `+tags` are ignored when comparing), cannot be an address a "use all domains" mailbox already receives, and cannot be `mailflare-reports`. The form shows the conflict inline.
- **Who can send.** `Anyone` accepts mail from anywhere and is the default, because addresses like `sales@` must receive outside mail. `People in your organisation` accepts only senders from your own domains. `Group members only` accepts only addresses that belong to a member. The last two need the sender's domain to pass DMARC; a failing message is refused with a `5.7.1` bounce (when your domain receives through Resend or Amazon SES it is dropped instead). A member whose domain publishes no DMARC record therefore cannot post to a members-only group.
- **Members.** Search for an account or a shared mailbox and select it to add it, or type an email address to add someone outside your organisation (see below). A group holds at most 500 members, of which at most 100 can be external, and a domain at most 50 groups. To give a team a shared inbox, add a shared mailbox as a member, or use the shared mailbox address directly.
- **Pause.** A paused group refuses mail to its address ("Group unavailable") and keeps its members.
- **Change the address.** Mail sent to the old address bounces once you save. Two groups whose addresses differ only by dots or a `+tag` are caught even when created at the same time; a mailbox or alias created at the same moment as such a variant is not. Mailflare creates the new Cloudflare Email Routing rule before it removes the old one.
- **Delete.** Removes the address, its members and its Cloudflare routing rule. Mail sent to it bounces afterwards. Members keep their own mailboxes.

If you switch a domain's receiving to Cloudflare (or turn Cloudflare receiving off and on again), Mailflare recreates the routing rules of its mailboxes and groups. Groups created while another provider received get their rule at that point.

On domains that receive through Cloudflare, creating a group adds an Email Routing rule that sends the address to Mailflare, the same as for a mailbox. If Cloudflare refuses the rule the group is not created.

## What the group does not do

- It stores no messages and has no inbox. Deliveries land in each member's mailbox.
- A copy is delivered unchanged, so DKIM and spam signals stay intact, and each member's own spam filter runs on their copy.
- The sender's own mailbox gets no second copy when they post to a group they belong to (they already have it in Sent).
- Members' out-of-office replies are not triggered by group copies.
- Sending as the group arrives in a later change.

## External members

An external member is an address outside your installation, such as an accountant or a contractor. Add one by typing the address in **Add members**. Addresses on your own domains are refused (add the account or shared mailbox instead), and so is the group's own address.

**Each copy to an external member is a billed send.** Mailflare re-sends the message through the domain's sending provider, once per external member. On Resend, Amazon SES and metered Cloudflare sending you pay for every copy, so a group with 20 external members costs 20 sends for every message it receives. The page asks you to confirm before adding one and shows the running count.

How the copy looks:

- It comes from the group address with the poster's name: `"'Bob <bob@gmail.com>' via Team" <team@example.com>`. The provider signs it with your domain's DKIM, so it passes DMARC at the member's provider even when the poster's domain publishes `p=reject`. `Reply-To` is the poster, or the group address when the group's reply-to is set to the group. The poster's real address is part of the name, so a display name cannot pose as someone else, and the original From is kept as `X-Original-From`. `References` includes the original Message-ID, so replies thread for the poster.
- The subject, body and attachments are unchanged. It carries `List-Id`, `List-Post`, `Precedence: list`, and `List-Unsubscribe` with a one-click link. Nothing is stored in a Sent folder and no webhooks fire.
- **Who is relayed.** In a group anyone can post to, external members receive a post only when its sender is qualified: a member, or an address on one of your own domains, with a trusted DMARC pass. Posts from anyone else reach internal members only, unless you turn on **Forward outside posts to external members** in the group's settings (off by default; the setting appears for groups that anyone can post to, and turning it on shows a warning). With it on, anyone who can reach the address can make your domain send a copy to every external member, spam included, and each copy is billed. Groups restricted to your organisation or to members already admit only qualified posters. Existing groups start with the setting off. Before the database migration that adds it is applied it reads as off.
- Only mail whose sender passed DMARC at the receiver is relayed, and only when it has a single From address. Mail the receiving provider marked as spam or a virus, or that Mailflare's own spam filters score as spam or suspicious (run once per message for the group, not per member), reaches internal members only. The poster does not get their own message back. A group that anyone can post to can still be used to send authenticated junk to its external members from your domain; use **Group members only** or **People in your organisation** for groups with external members when that matters.
- **Send caps.** Every relayed copy is a send, so the caps count messages times external members: 200 an hour and 500 a day for one group, 800 an hour and 2000 a day for the whole installation (constants in `src/lib/groups/relay-utils.ts`). Over a cap, internal members still receive the message and external members are skipped. The first time a cap trips in a period an audit entry `group.relay_capped` is written and the group page shows a warning for 24 hours. Caps are kept as small marker objects in the bucket (no database or queue operations), and each message is counted once however large the group is.
- Copies of one message are released two per second across the whole group, and a provider's "too many requests" answer re-queues that one copy with a growing delay (up to six times) instead of using up its three retries.
- If the domain has no sending provider (or Cloudflare sending is not switched on), external members receive nothing and the group page says so.

Bounces and unsubscribing:

- With suppression in `enforce` mode (**Admin → Deliverability**), an address that bounced or reported spam is skipped and shows a **Suppressed** badge. In `record` and `off` modes copies are still sent.
- Every copy has an unsubscribe link (and the `List-Unsubscribe-Post` header mail clients use for their own unsubscribe button). The link names one member row of one group, is signed with a random key that Mailflare keeps in the bucket (`secrets/group-unsubscribe.key`, created on first use, so rotating `CF_TOKEN` does not break links already sent; deleting the object revokes them all), shows a confirmation page when opened, and removes the member only when confirmed, which is logged as `group.member_unsubscribed`. **One-click unsubscribe needs `APP_URL` set to the public https address**; without it copies are sent without unsubscribe headers, and the group page warns about that while it has external members. Re-adding an address that unsubscribed from the group works but shows a warning.
- Relayed copies carry the group marker, so a copy that comes back to the group is dropped. An automated message (`Auto-Submitted` other than `no`, an auto-reply header, or a `Precedence` of `auto_reply`, `bulk` or `junk`) is dropped when it comes from an external member's own address, or when its `In-Reply-To` or `References` names a copy Mailflare relayed for this group (whatever address it is sent from), so a member's helpdesk auto-acknowledgement cannot start a loop. This also drops genuine automated mail from a member, such as invoices from a vendor you added as a member. Automated mail from anyone else, such as alerts and invoices, is still delivered. An acknowledgement that neither comes from the member nor quotes our Message-ID is not recognised; the send caps bound the damage, and copies carry `Precedence: list`, which well-behaved auto-responders skip.
- Bounces of relayed copies: Mailflare remembers the Message-ID the provider gave each copy for 7 days. A bounce that reaches the group address, names such an ID and a failed (5.x.x) recipient that is that copy's own member is recorded as a hard-bounce suppression for the domain (when suppression is not `off`) and then dropped; this is how Cloudflare sending bounces, which go to the From address, are learned. Resend and Amazon SES report bounces through their webhooks as well.
- A relay that fails at the provider is retried up to three times. SES and Cloudflare sending have no duplicate protection, so a send the provider accepted but reported as failed can reach a member twice. Queueing the relays of a chunk of members is at most once: if the queue fails part-way, those members miss that message (it is logged) rather than being billed twice.
- The relay copy of the message is kept for 7 days for retries and then removed by the daily sweep.

## Audit log

Every change is in **Admin → Audit logs**: `group.created`, `group.updated` (with the names of the fields that changed), `group.deleted`, `group.member_added`, `group.member_updated`, `group.member_removed` and `group.member_unsubscribed` (an external member used their unsubscribe link; no acting user). Adding an external member records its address.

## API used by the page

These session routes serve the admin page. The same operations are in `/api/v1/groups` (the `groups` API key scope) and the `manage_groups` MCP tool; see [API](api.md).

| Route | Purpose |
| --- | --- |
| `GET`, `POST /api/groups` | List, create |
| `GET`, `PATCH`, `DELETE /api/groups/{id}` | Read, update, delete |
| `POST /api/groups/{id}/members` | Add up to 50 members (`{ members: [{ kind, userId \| mailboxId \| email }] }`) |
| `PATCH`, `DELETE /api/groups/{id}/members/{memberId}` | Update, remove |
| `GET /api/groups/{id}/candidates?q=` | Search accounts and shared mailboxes to add |
| `GET`, `POST /api/groups/unsubscribe/{token}` | Public: confirmation page and unsubscribe for an external member (signed token) |

Errors: `409` address taken, `422` cap reached or invalid member, `404` unknown group or a domain you cannot use, `502` Cloudflare refused the routing rule, `503` with `code: "MIGRATION_REQUIRED"` until the database migration has been applied.
