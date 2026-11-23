# Plus-addressing

Mail sent to `user+tag@your-domain` is delivered to the `user` mailbox. The text after the `+` is a tag: it stays part of the address, so `user+receipts` and `user+news` reach the same inbox but remain distinguishable to rules. Every mailbox and alias accepts tagged mail; there is nothing to set up.

## How a tagged address resolves

For `user+tag@your-domain`, the full address is tried first and the `user` base second:

1. **Domain block rules** run before any mailbox lookup, so a reject rule can refuse a tagged address outright.
2. **The full `user+tag` local part** is tried on the domain: a mailbox literally named `user+tag`, then an enabled alias with that name. Either wins over the `user` base, so a specific tag can be claimed as its own address. A disabled alias still owns its address: mail to it is rejected rather than delivered elsewhere. Last, an all-domains mailbox named `user+tag` claims it on the domains it covers.
3. **The `user` base** is tried the same way: mailbox, alias, disabled alias, all-domains mailbox.
4. **Catch-all and forwarding rules** take whatever is still unclaimed.

The all-domains check compares base addresses, so a mailbox that owns `user` on a domain also owns every `user+tag` there. For the same reason, another mailbox cannot take `user+tag` as an alias on a domain an all-domains `user` already covers.

## Rules on the tag

Mailbox rules under **Settings → Rules & Routing** can match on **Recipient tag**, the part after the `+`:

- Matching is case-insensitive and keeps dots: a `receipts` rule matches `+RECEIPTS`, while `my.tag` and `mytag` stay different tags. That differs from the address lookup, where dots never count.
- One leading `+` in the rule value is dropped: `+receipts` and `receipts` are the same rule.
- `*` means "carries any tag", not "any message". Untagged mail never matches a tag rule, and an empty `user+` does not either.
- Folder, Spam, Trash and forward destinations all work with the tag field.

Tag rules read the address the message was delivered to, not the To header. Domain routing rules have no tag field; they match the full recipient address, tag included.

## The `+tag` chip

A `+tag` chip marks tagged mail on the rows of the message list and on the To line when reading a message. It is read from the stored To header, which on ordinary mail is the address the message was delivered to. On mail that arrived by Bcc or through a mailing list the header names a different address, so the chip shows that header's tag, or none, rather than the tag the delivery used.

## Turning tagged mail off

There is no per-mailbox switch yet. To keep `+tag` mail out of an inbox, create a mailbox rule that files it away:

1. Open **Settings → Rules & Routing**.
2. Under **Mailbox rules**, choose **New rule**.
3. Set **Field** to **Recipient tag**, **Value** to `*`, and **Destination** to **Trash** (Spam or a folder also work).
4. Choose **Create rule**. Tagged mail is still accepted, but lands in the chosen destination instead of the inbox.

To refuse tagged mail at the edge, so the sender gets a bounce, a domain block rule is needed. Those match the whole recipient address rather than the tag field: under **Domain routing**, add a **Reject / block** rule matching the **Recipient address** with a regular expression such as `^user\+.+@`, which rejects every tag on `user`. On domains that receive through Resend or Amazon SES the same rule drops the message instead of rejecting it, like [every reject rule](providers.md#behavior-that-differs-from-cloudflare).

## Address details

- `user+` (a trailing `+` with no tag) is a literal address. It does not fall back to `user` and never counts as tagged for rules, so it delivers only to a literal `user+` mailbox or alias, or to a catch-all rule.
- `user+a+b` splits at the first `+`: base `user`, tag `a+b`.
- When finding the mailbox, dots and case never count anywhere in the local part: `U.Ser+Ta.g` still reaches `user`. Dots do count for tag rules, as above.
- `+tag@domain` and `+@domain` are not valid addresses: a local part with no base is undeliverable.

## Sending

Plus-addressing is inbound only. The From of an outgoing message is always the mailbox's or alias's own address and the server refuses any other, so a reply to tagged mail goes out from the plain `user@` address, not `user+tag@`. The exception is a mailbox literally named `user+tag`, whose own address already contains the tag.
