# Spam protection

Mailflare analyzes stored incoming messages locally. The filter combines trusted authentication results, sender relationships, mailbox-scoped reputation, bounded Bayesian token learning, URL checks, message structure, and attachment metadata. Message bodies are never sent to an external service. Optional lookups do send the sender's IP address and the sender and link domains: Spamhaus DQS (with your key), abuse.ch URLhaus (with your key) and, unless switched off under **Admin → Spam filter**, domain-age queries to rdap.org. Redirects from these lookups are followed only to public https hosts.

Scores range from 0 to 100. Messages scoring 55 or higher move to Spam by default (see **Strictness** below).

A passing SPF, DKIM or DMARC result only proves that mail came from the domain it claims, and a throwaway domain passes for its own mail. Passes therefore lower the score in full only for senders you have a relationship with: a manually saved contact, an address you have written to, a sender or domain you have repeatedly marked as legitimate, or an address that has already written to the mailbox at least twice without being reported as spam. For a first-time sender a pass counts for half (at most 7 points instead of 14), while a failure still adds its full score. A first-time sender (no saved contact, and no earlier message from that exact address) that pitches search-engine or traffic services for your own website (it names your domain, matches at least two typical SEO sales phrases, is not a reply and has no unsubscribe header) also gets a +45 signal.

Scores from 40 through 69 are recorded as suspicious but remain in their normal Inbox or custom folder. Analysis failures also deliver normally. Automatic replies and new-message notifications are suppressed for messages placed in Spam.

The Spam Filter switch is under **Settings → Inbox → Spam protection** and is enabled by default. Disabling it affects future incoming messages; it does not move or rescan existing mail.

**Strictness** sits next to the switch: Relaxed moves mail to Spam at a score of 85, Normal at 70 and Strict (the default) at 55. It is stored per user, applies to future messages in all your mailboxes, and does not change the suspicious band (40 and up) or authentication-policy filing, such as a failed DMARC, which stays in Spam at every level.

Use **Report spam** to train a message as spam. Use **Not spam** from the Spam folder to train it as legitimate and return it to Inbox. **Block contact** trashes future mail from one address with a mailbox rule. **Block sender domain**, in the same menu, adds a rule that trashes mail from the sender's registrable domain (`mail.example.com` blocks `example.com`) and all its subdomains. It is refused for a domain hosted on the installation or containing one, and for shared mail providers such as Gmail, Outlook, Yahoo or iCloud, where it would block everyone on the service (the menu item is hidden for those; use **Block contact**). The rule can be removed under the mailbox's routing rules.

Learning is scoped to the message's mailbox, only explicit user feedback trains the classifier, and changing a decision reverses the previous training first.

Mailflare accepts mail before this analysis. Forward-only routing occurs before stored-message filtering and is outside the filter's v1 scope.

## Rules for newsletters and promotional mail

Routing rules can match on **Newsletter or promotional mail** instead of text. One rule is enough to move all such mail to a folder, Spam or Trash, or to forward it with a kept copy. Pick it in the rule's field list under **Settings → Inbox** (mailbox rules) or **Domain routing**; there is no value to enter.

The condition is usually newsletters and marketing mail, but some notifications (for example GitHub or ticketing tools) carry the same headers and match too. Because a match can be wrong, these rules are limited to actions that keep the message: a folder, Spam, Trash, or a forward that keeps a copy. Reject and forwarding without a copy are refused, in the interface and by the API.

Detection reads headers only, so it works the same for mail received through Cloudflare, SMTP, Resend and SES. A message counts when it has any of:

- `List-Unsubscribe` (RFC 2369)
- `List-Id` (RFC 2919)
- `Precedence: bulk`, `list` or `junk`
- `X-Campaign` or `X-Campaign-ID`

`Feedback-ID` alone does not count, because SES, Postmark and Google also add it to transactional mail such as one-time codes. Provider trace headers and `Auto-Submitted` auto-replies do not count either. The check is independent of spam scoring: a newsletter is not spam, and spam is not necessarily a newsletter. A sender that omits all of these headers is not detected.
