# Spam protection

Mailflare analyzes stored incoming messages locally. The filter combines trusted authentication results, sender relationships, mailbox-scoped reputation, bounded Bayesian token learning, URL checks, message structure, and attachment metadata. Message bodies are never sent to an external service. Optional lookups do send the sender's IP address and the sender and link domains: Spamhaus DQS (with your key), abuse.ch URLhaus (with your key) and, unless switched off under **Admin → Spam filter**, domain-age queries to rdap.org. Redirects from these lookups are followed only to public https hosts.

Scores range from 0 to 100. Messages scoring 70 or higher move to Spam.

A passing SPF, DKIM or DMARC result only proves that mail came from the domain it claims, and a throwaway domain passes for its own mail. Passes therefore lower the score in full only for senders you have a relationship with: a manually saved contact, an address you have written to, a sender or domain you have repeatedly marked as legitimate, or an address that has already written to the mailbox at least twice without being reported as spam. For a first-time sender a pass counts for half (at most 7 points instead of 14), while a failure still adds its full score.

Scores from 40 through 69 are recorded as suspicious but remain in their normal Inbox or custom folder. Analysis failures also deliver normally. Automatic replies and new-message notifications are suppressed for messages placed in Spam.

The Spam Filter switch is under **Settings → Inbox → Spam protection** and is enabled by default. Disabling it affects future incoming messages; it does not move or rescan existing mail.

Use **Report spam** to train a message as spam. Use **Not spam** from the Spam folder to train it as legitimate and return it to Inbox. Learning is scoped to the message's mailbox, only explicit user feedback trains the classifier, and changing a decision reverses the previous training first.

Mailflare accepts mail before this analysis. Forward-only routing occurs before stored-message filtering and is outside the filter's v1 scope.
