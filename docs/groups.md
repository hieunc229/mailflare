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

- It comes from the group address with the poster's name: `"'Bob' via Team" <team@example.com>`. The provider signs it with your domain's DKIM, so it passes DMARC at the member's provider even when the poster's domain publishes `p=reject`. `Reply-To` is the poster, or the group address when the group's reply-to is set to the group.
- The subject, body and attachments are unchanged. It carries `List-Id`, `List-Post`, `Precedence: list`, and `List-Unsubscribe` with a one-click link. Nothing is stored in a Sent folder and no webhooks fire.
- Only mail whose sender passed DMARC at the receiver is relayed, and not mail the receiving provider marked as spam or a virus; other mail reaches internal members only. The poster does not get their own message back. Mailflare does not score the content of relayed mail, so a group that anyone can post to can be used to send spam to its external members from your domain: use **Group members only** or **People in your organisation** for groups with external members when that matters. As a circuit breaker a group relays at most 120 messages an hour; further mail still reaches internal members, and the external members are skipped until the hour is over.
- Copies to the members of one message are released a couple per second, so a provider's rate limit is not hit by 100 sends at once.
- If the domain has no sending provider (or Cloudflare sending is not switched on), external members receive nothing and the group page says so.

Bounces and unsubscribing:

- With suppression in `enforce` mode (**Admin → Deliverability**), an address that bounced or reported spam is skipped and shows a **Suppressed** badge. In `record` and `off` modes copies are still sent.
- Every copy has an unsubscribe link (and the `List-Unsubscribe-Post` header mail clients use for their own unsubscribe button). The link is signed for one address in one group, shows a confirmation page when opened, and removes the member only when confirmed, which is logged as `group.member_unsubscribed`. It needs `APP_URL` and a server secret (`CF_TOKEN`, `CF_API_KEY` or `INBOUND_WEBHOOK_SECRET`); without them copies are sent without unsubscribe headers.
- Relayed copies carry the group marker, so a copy that comes back to the group is dropped. An automated message (`Auto-Submitted` other than `no`, an auto-reply header, or a `Precedence` of `auto_reply`, `bulk` or `junk`) sent to the group from an external member's own address is dropped too, so a member's helpdesk auto-acknowledgement cannot start a loop. This also drops genuine automated mail from a member, such as invoices from a vendor you added as a member. Automated mail from anyone else, such as alerts and invoices, is still delivered. A helpdesk that acknowledges from a different address than the member's (for example `support@acme.zendesk.com` for the member `support@acme.com`) is not recognised; the hourly relay limit bounds the damage, and the copies are sent with `Precedence: list`, which well-behaved auto-responders skip.
- Bounces of relayed copies are recorded for suppression when the domain sends through Resend or Amazon SES (their webhooks name the failed address). Cloudflare sending reports bounces to the group address, where they are dropped as delivery reports, so those addresses are not suppressed automatically.
- A relay that fails at the provider is retried up to three times. SES and Cloudflare sending have no duplicate protection, so a send the provider accepted but reported as failed can reach a member twice.
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
