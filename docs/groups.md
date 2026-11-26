# Groups

A group is an address such as `team@example.com` that delivers a copy of every message to each of its members. Use it for `sales@`, `billing@` or `team@` addresses that several people read. Each member gets the message in their own inbox, so nobody shares a mailbox.

Groups need a Pro or Team licence (the same one that unlocks accounts). Without it the **Groups** page shows an upgrade card, the API answers `403` with `code: "LICENSE_REQUIRED"`, and mail to an existing group address is treated as if the address did not exist.

## Manage groups

Open **Admin → Groups**. You need the permission to manage users, and you can only use domains you can already use for mailboxes.

- **Create.** Pick a domain, a local part, a name, and who can send to the group. The address cannot be one that a mailbox, alias or another group already uses (dots and `+tags` are ignored when comparing), cannot be an address a "use all domains" mailbox already receives, and cannot be `mailflare-reports`. The form shows the conflict inline.
- **Who can send.** `Anyone` accepts mail from anywhere and is the default, because addresses like `sales@` must receive outside mail. `People in your organisation` accepts only senders from your own domains. `Group members only` accepts only addresses that belong to a member. The last two need the sender's domain to pass DMARC; a failing message is refused with a `5.7.1` bounce (when your domain receives through Resend or Amazon SES it is dropped instead). A member whose domain publishes no DMARC record therefore cannot post to a members-only group.
- **Members.** Search for an account or a shared mailbox and select it to add it. A group holds at most 500 members and a domain at most 50 groups. To give a team a shared inbox, add a shared mailbox as a member, or use the shared mailbox address directly.
- **Pause.** A paused group refuses mail to its address ("Group unavailable") and keeps its members.
- **Change the address.** Mail sent to the old address bounces once you save. Mailflare creates the new Cloudflare Email Routing rule before it removes the old one.
- **Delete.** Removes the address, its members and its Cloudflare routing rule. Mail sent to it bounces afterwards. Members keep their own mailboxes.

On domains that receive through Cloudflare, creating a group adds an Email Routing rule that sends the address to Mailflare, the same as for a mailbox. If Cloudflare refuses the rule the group is not created.

## What the group does not do

- It stores no messages and has no inbox. Deliveries land in each member's mailbox.
- A copy is delivered unchanged, so DKIM and spam signals stay intact, and each member's own spam filter runs on their copy.
- The sender's own mailbox gets no second copy when they post to a group they belong to (they already have it in Sent).
- Members' out-of-office replies are not triggered by group copies.
- External (outside) members, sending as the group, and API access arrive in later changes.

## Audit log

Every change is in **Admin → Audit logs**: `group.created`, `group.updated` (with the names of the fields that changed), `group.deleted`, `group.member_added`, `group.member_updated` and `group.member_removed`.

## API used by the page

These session routes serve the admin page (the public API and MCP tool come later):

| Route | Purpose |
| --- | --- |
| `GET`, `POST /api/groups` | List, create |
| `GET`, `PATCH`, `DELETE /api/groups/{id}` | Read, update, delete |
| `POST /api/groups/{id}/members` | Add up to 50 members (`{ members: [{ kind, userId \| mailboxId }] }`) |
| `PATCH`, `DELETE /api/groups/{id}/members/{memberId}` | Update, remove |
| `GET /api/groups/{id}/candidates?q=` | Search accounts and shared mailboxes to add |

Errors: `409` address taken, `422` cap reached or invalid member, `404` unknown group or a domain you cannot use, `502` Cloudflare refused the routing rule, `503` with `code: "MIGRATION_REQUIRED"` until the database migration has been applied.
