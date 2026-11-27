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
- Only the members you choose can send as the group (see below); everyone else cannot.

## Send as the group

An admin can let chosen account members write mail from the group address (`team@example.com`). On the group page, each account member has a **Can send as group** switch, off by default. Shared mailboxes and external members cannot have it. You can also set it when adding a member through the API (`canSendAs: true`) or change it later; every change is in the audit log (`group.member_added`, `group.member_updated` with `canSendAs`).

- **Where it shows up.** The member picks the group address in the **From** list of the composer, listed under their own primary mailbox. It is also an identity for JMAP mail apps. Shared mailboxes and a member's secondary mailboxes never list it.
- **What goes out.** The message is sent from the group address with the group's name (`"Team" <team@example.com>`), through the group domain's own sending provider, so it carries that domain's DKIM and aligns for DMARC. The member's own name is not added.
- **Sent copy.** There is no group mailbox (D-10). The Sent copy is stored in the sender's own mailbox, and replies to the group arrive through the group as usual, so every member gets them.
- **Who is allowed.** Only an active account that is a user member of an enabled group with the switch on, sending from its own primary mailbox, on an installation with the Pro or Team licence. The address must be the group's exact address (`team+x@` or `te.am@` are not the group). Every way of sending checks this the same way: the web composer and drafts, the `/api/send` and `/api/v1/send` APIs, MCP, and JMAP (`Email/set` drafts and `EmailSubmission/set`). A send that is scheduled or waiting out the undo window is checked again when it is delivered, so turning the switch off, pausing the group, removing the member, disabling the account or losing the licence stops it. SMTP submission (the `feat/smtp-submission` change) is covered the same way: it lists addresses through `listSendableAddresses`, which includes the groups a member may send as, and sends through `sendEmail`.
- **Posting to the group itself.** A member who sends as the group to the group (the group in To, Cc or Bcc) counts as a member, so a members-only group accepts the post, and their own mailbox gets no second copy. Mailflare adds a signed `X-Mailflare-Send-As` header only to a message that names the group; it names the stored message and the group. It counts only when the From is the group address, the receiver reports a DMARC pass, and the marker verifies and has not been used before (the first admission is recorded under `group-relay/<day>/sendas/` and swept with the other relay records, and a marker of a message older than that is refused), so nobody outside can use it. The Message-ID is not part of the signature: the provider assigns it after Mailflare hands the message over. If the signing key cannot be read the send still goes out without the header and the group's normal post policy applies.
- **Replies.** A reply or forward defaults to the member's own address, never the group, whether the mail was sent to the group or was sent as the group; the group stays selectable in the From list. Reply-all from the personal address keeps the group among the recipients.
- **Audit.** Each send as a group writes an `email.send_as_group` entry (who, group, message). Saving the switch with the value it already has writes nothing.
- **No mailbox at the account's address.** The switch still saves, but the group page notes that the group will not appear in that member's From list, since it is listed under the account's own primary mailbox.
- **Pausing or deleting the group** removes the address from the From list at once.

## External members

An external member is an address outside your installation, such as an accountant or a contractor. Add one by typing the address in **Add members**. Addresses on your own domains are refused (add the account or shared mailbox instead), and so is the group's own address.

**Each copy to an external member is a billed send.** Mailflare re-sends the message through the domain's sending provider, once per external member. On Resend, Amazon SES and metered Cloudflare sending you pay for every copy, so a group with 20 external members costs 20 sends for every message it receives. The page asks you to confirm before adding one and shows the running count.

How the copy looks:

- It comes from the group address with the poster's name: `"'Bob <bob@gmail.com>' via Team" <team@example.com>`. The provider signs it with your domain's DKIM, so it passes DMARC at the member's provider even when the poster's domain publishes `p=reject`. `Reply-To` is the poster, or the group address when the group's reply-to is set to the group. The poster's real address is part of the name, so a display name cannot pose as someone else, and the original From is kept as `X-Original-From`. `References` includes the original Message-ID, so replies thread for the poster.
- The subject, body and attachments are unchanged. It carries `List-Id`, `List-Post`, `Precedence: list`, and `List-Unsubscribe` with a one-click link. Nothing is stored in a Sent folder and no webhooks fire.
- **Who is relayed.** In a group anyone can post to, external members receive a post only when its sender is qualified: a member, or an address on one of your own domains, with a trusted DMARC pass. Posts from anyone else reach internal members only, unless you turn on **Forward outside posts to external members** in the group's settings (off by default; the setting appears for groups that anyone can post to, and turning it on shows a warning). With it on, anyone who can reach the address can make your domain send a copy to every external member, spam included, and each copy is billed. Groups restricted to your organisation or to members already admit only qualified posters. Existing groups start with the setting off. Before the database migration that adds it is applied it reads as off.
- Only mail whose sender passed DMARC at the receiver is relayed, and only when it has a single From address. Mail the receiving provider marked as spam or a virus, or that Mailflare's spam filters call spam (the same checks and blocklists as inbound filtering, run once per message for the group rather than per member; a merely suspicious message is relayed), reaches internal members only, and an audit entry `group.relay_blocked` records it. The poster does not get their own message back. See below for who counts as qualified.
- **Send caps.** Every relayed copy is a send, so the caps count messages times external members, per group and for the whole installation: by default 300 an hour and 1000 a day for one group, 600 an hour and 2000 a day for the installation. Set `GROUP_RELAY_GROUP_HOURLY`, `GROUP_RELAY_GROUP_DAILY`, `GROUP_RELAY_INSTALL_HOURLY` and `GROUP_RELAY_INSTALL_DAILY` to whole numbers to change them (an invalid value keeps the default). **Each send is billed on Resend, Amazon SES and metered Cloudflare sending, and each relay also costs 3 queue operations (write, read, delete) against the 10,000 a day of Cloudflare's Free queue allowance, shared with all inbound mail: the defaults are ceilings, not targets, so lower them to what you are willing to pay for. Each relay is about 3 queue operations, so the installation default of 2000 sends a day is about 6,000 operations and leaves room for inbound mail under the Free allowance; raising the installation caps past about 2000 a day needs Workers Paid or accepts Queues billing.** Over a cap, internal members still receive the message and external members are skipped. The first time a cap trips in a period an audit entry `group.relay_capped` is written and the group page shows a warning for 24 hours. A message reserves its sends before it is checked and backs out if the totals then exceed a cap, so two messages arriving together cannot both take the last of the allowance (they may both back out). Caps are kept as small marker objects in the bucket (no database or queue operations).
- Copies of one message are released two per second across the whole group, and a provider's "too many requests" answer re-queues that one copy with a growing delay (up to six times) instead of using up its three retries.
- If the domain has no sending provider (or Cloudflare sending is not switched on), external members receive nothing and the group page says so.

Bounces and unsubscribing:

- With suppression in `enforce` mode (**Admin → Deliverability**), an address that bounced or reported spam is skipped and shows a **Suppressed** badge. In `record` and `off` modes copies are still sent.
- Every copy has an unsubscribe link (and the `List-Unsubscribe-Post` header mail clients use for their own unsubscribe button). The link names one member row of one group, is signed with a random key that Mailflare keeps in the bucket (`secrets/group-unsubscribe.key`, created on first use, so rotating `CF_TOKEN` does not break links already sent; deleting the object revokes them all), shows a confirmation page when opened, and removes the member only when confirmed, which is logged as `group.member_unsubscribed`. **One-click unsubscribe needs `APP_URL` set to the public https address**; without it copies are sent without unsubscribe headers, and the group page warns about that while it has external members. Re-adding an address that unsubscribed from the group works but shows a warning.
- Relayed copies carry the group marker, so a copy that comes back to the group is dropped. An automated message (`Auto-Submitted` other than `no`, an auto-reply header, or a `Precedence` of `auto_reply`, `bulk` or `junk`) is dropped when it comes from an external member's own address, or when its `In-Reply-To` or `References` names a copy Mailflare relayed for this group (whatever address it is sent from), so a member's helpdesk auto-acknowledgement cannot start a loop. This also drops genuine automated mail from a member, such as invoices from a vendor you added as a member. Automated mail from anyone else, such as alerts and invoices, is still delivered. An acknowledgement that neither comes from the member nor quotes our Message-ID is not recognised; the send caps bound the damage, and copies carry `Precedence: list`, which well-behaved auto-responders skip.
- Bounces of relayed copies: Mailflare remembers the Message-ID the provider gave each copy for 7 days. A bounce that reaches the group address, names such an ID and a failed (5.x.x) recipient that is that copy's own member is recorded as a hard-bounce suppression for the domain (when suppression is not `off`) and then dropped; this is how Cloudflare sending bounces, which go to the From address, are learned. Like every address learned from a bounce message it is recorded unconfirmed, because the Message-IDs of relayed copies are visible to members and a bounce can be forged: it is enforced once a second bounce names a different copy, or an admin confirms it. Resend and Amazon SES report bounces through their webhooks as well.
- A relay that fails at the provider is retried up to three times. SES and Cloudflare sending have no duplicate protection, so a send the provider accepted but reported as failed can reach a member twice. Queueing the relays of a chunk of members is at most once: if the queue fails part-way, those members miss that message (it is logged) rather than being billed twice.
- Everything relaying writes to the bucket lives under `group-relay/<day>/...` (relay copies, Message-ID records, cap and chunk markers). The daily sweep deletes whole days older than 7 days, so cleaning does not depend on how much was written.
- A post whose attachments the provider cannot carry (over 5 MiB with Cloudflare sending, over 25 MB elsewhere) is not relayed: relayed files are not stored, so they cannot be turned into download links as for a normal send. An audit entry `group.relay_skipped` says so, once per message.
- Non-ASCII names: List-Id and `X-Original-From` carry RFC 2047 encoded words. The From name goes to Resend as UTF-8, to Amazon SES as encoded words (which SES requires) and to Cloudflare as a separate name field, because those providers encode it themselves.

## Audit log

Every change is in **Admin → Audit logs**: `group.created`, `group.updated` (with the names of the fields that changed), `group.deleted`, `group.member_added`, `group.member_updated`, `group.member_removed` and `group.member_unsubscribed` (an external member used their unsubscribe link; no acting user). Adding an external member records its address.

## API used by the page

These session routes serve the admin page. The same operations are in `/api/v1/groups` (the `groups` API key scope) and the `manage_groups` MCP tool; see [API](api.md).

| Route | Purpose |
| --- | --- |
| `GET`, `POST /api/groups` | List, create |
| `GET`, `PATCH`, `DELETE /api/groups/{id}` | Read, update, delete |
| `POST /api/groups/{id}/members` | Add up to 50 members (`{ members: [{ kind, userId \| mailboxId \| email, canSendAs? }] }`) |
| `PATCH`, `DELETE /api/groups/{id}/members/{memberId}` | Update (`{ canSendAs }`, account members only), remove |
| `GET /api/groups/{id}/candidates?q=` | Search accounts and shared mailboxes to add |
| `GET`, `POST /api/groups/unsubscribe/{token}` | Public: confirmation page and unsubscribe for an external member (signed token) |

Errors: `409` address taken, `422` cap reached or invalid member, `404` unknown group or a domain you cannot use, `502` Cloudflare refused the routing rule, `503` with `code: "MIGRATION_REQUIRED"` until the database migration has been applied.
