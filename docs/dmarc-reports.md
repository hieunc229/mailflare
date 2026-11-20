# DMARC aggregate reports

Mailbox providers (Google, Microsoft, Yahoo and others) send a daily summary of the mail they received that claims to be from your domain, if your DMARC record asks for it with a `rua=` address. Mailflare can be that address: it reads the reports, keeps daily totals and shows who is sending as you and whether your own mail passes DMARC. It is **off by default**, per sending domain. Nothing changes until a domain admin turns it on under **Admin → Email → Deliverability → DMARC reports**.

## Turning it on

"Turn on DMARC reports" for a domain:

1. **Report address.** `mailflare-reports@<your domain>`, the same local part on every domain. It is not a mailbox and cannot be renamed. It is refused if a mailbox or alias on that domain already uses `mailflare-reports`. Using an address on your own domain means no extra "external destination" DNS record is needed.
2. **Receiving.** On Cloudflare receiving, an Email Routing rule sends the address to the Worker. With Resend or SES receiving, and with the self-hosted SMTP listener, every recipient on the domain already arrives, so no rule is created. A domain with receiving off cannot turn reports on.
3. **`_dmarc` record.** The page shows the current and the new record and changes nothing until you confirm.
   - No record: `v=DMARC1; p=none; rua=mailto:<address>` is created. For a subdomain, the new record copies its organisation's effective policy instead of `p=none` (the organisation's `sp`, else `p`, with `adkim`, `aspf` and `pct` kept), because a subdomain without a record inherits that policy and enabling reports must not change what receivers do with its mail. The organisation's own record is looked up first; if that lookup fails nothing is changed.
   - A record without our address: `mailto:<address>` is appended to `rua` (or a `rua` tag is added). Every other tag, its spacing and its order stay as they were.
   - More than one DMARC record at `_dmarc`: refused, remove the extra ones first.
   - A zone that Mailflare does not manage (`manual`): the new value is shown so you can publish it yourself.

Confirming applies exactly the record shown: the dialog sends the previewed before and after values, and the server refuses (`DMARC_CHANGED`) if `_dmarc` is different by then. If the DNS step fails after the routing rule was created, the rule is removed again and reporting stays off.

"Turn off" removes only our address from `rua` (and the tag if it becomes empty), deletes the routing rule and keeps the stored data until it is 180 days old. If turning on created the `_dmarc` record (there was none) and it still reads exactly as we wrote it, turning off deletes the record again; if it was edited since, only our address is removed. The created text is stored in `domain_deliverability.dmarc_created_record`. While reporting is on, a mailbox or alias named `mailflare-reports` cannot be created on that domain.

The policy (`p=none`, `quarantine`, `reject`) is yours to change. Mailflare never raises it.

## How a report is handled

Report mail is not stored in any mailbox. `resolveIncomingMail` answers `{ action: "report" }` for the address: no reject or forward rule (a catch-all included) applies and the mail is never forwarded, neither by a rule nor by an account's forwarding address, on the Worker and on the SMTP and relay paths. It is stored and queued, and the queue consumer parses it before routing. The raw mail is deleted afterwards. Only totals are kept: one row per report and one row per day, source IP and result.

### Who is believed

Anyone can email the address, and anyone can claim to be Google. A report is a **verified reporter's** only when both hold:

1. the report mail's own `From` domain passed DMARC (same trust rules as spam analysis: `Authentication-Results` written by Cloudflare, SES or Resend verdicts, or the self-hosted listener's own check), and
2. the organisational domain of that `From` equals the organisational domain of the contact `email` inside the report's `report_metadata`.

So an attacker's own domain can pass DMARC, but it cannot pass itself off as `google.com`: the report would have to be sent from `google.com`. Organisational domains come from the Public Suffix List (`tldts`, private suffixes included), so `example.co.uk`, `example.eu.org` and `alice.github.io` are each their own organisation and tenants of a shared suffix never count as one.

Only verified reports write aggregate rows. Every other report is stored as one row (`status = unverified`) and shown as a count on the page; it contributes no totals, no source rows and no alert input, and it does not reset the no-reports alert. The report key includes whether the report was verified and who the verified reporter is, and aggregate rows carry the verified reporter's domain (not the `org_name` the XML claims), so an unverified report can never claim a verified report's key and two reporters' rows never merge.

### Limits

Every step is bounded:

| Limit | Value |
|---|---|
| Report mail | 5 MiB |
| Compressed attachment | 3 MiB |
| Decompressed | 8 MiB, counted as it streams (compressed input reaches the inflater in 16 KiB slices, so the count holds whatever chunk sizes the runtime produces); also at most 1,000 times the compressed size (64 KiB is always allowed). The 8 MiB absolute cap is the real bound: with a 3 MiB attachment the ratio is never the tighter limit, it only stops a small input from expanding towards the cap |
| Zip | exactly one entry, not encrypted, a `.xml` name |
| XML | `<!DOCTYPE` and `<!ENTITY` are rejected; nothing is expanded; comments are skipped; at most 20,000 records |
| Count per row | at most 10,000,000, a larger row is skipped |
| Report date range | at most 7 days; a report may start from 180 days ago to one day ahead |
| Rows written per report | the 500 busiest (source, result) rows; the report says so |
| Reports per domain per UTC day, mail that did not pass DMARC | 300 (they are only ever rows; junk cannot take anything else's share) |
| Reports per domain per UTC day, mail that passed DMARC | 300 per sending organisation, 2,000 in total |
| Aggregate rows per UTC day written by verified reports | 5,000 per domain, 1,000 per verified reporter; a report that would exceed either is recorded as `over_budget` with no rows |
| Reverse lookups | 5 per report, 10 per queue batch (a batch is 5 messages on Workers), 2 second budget |

The XML scanner is a small linear one: names match by local name (`<d:record>` is read as `record`), closing tags may carry whitespace, a `>` inside a quoted attribute value does not end a tag, numeric character references (`&#65;`, `&#x41;`) are decoded within Unicode bounds in a single pass, and CDATA is text.

The report must be about your domain: the `policy_published` domain has to be the domain itself or a subdomain of it (a parent domain is refused). A report is recorded once: a duplicate, or a queue redelivery, changes nothing. Order of work for one mail: it is counted against the daily caps, a `processing` row is committed under the raw object's key, the mail is parsed, then the row is completed under the report's own key. A run killed in between leaves a `processing` row; on redelivery it is marked `failed` ("Processing was interrupted") rather than retried, since it may already have written totals. A report that cannot be read is recorded as `rejected` or `failed` with a short reason, shown under **Recent reports**, and never retried. Parsing problems never reach the queue's retry: each message is acknowledged or retried on its own, and only a database error before anything is written is thrown. Database writes go in batches of 50 statements, each statement under 100 bound parameters (D1's limit).

No URL from a report is ever fetched. The only network call is a reverse DNS (PTR) lookup for the busiest source IPs of a report, through the same DNS-over-HTTPS resolver the app already uses for DNS checks (so Cloudflare's resolver sees those IPs). A name that is not a plain host name is not stored. Each lookup is a subrequest, which is why the per-batch budget exists.

## The page

- **Range** 7, 30 or 90 days. A daily stacked chart: DMARC pass (DKIM or SPF aligned), failed but delivered, quarantined, rejected. A table of the same numbers is available to screen readers.
- **By source**: IP, host name (reverse DNS), reporters, messages, DMARC pass, DKIM aligned and SPF aligned percentages, worst result.
- **By reporter**: reports, messages, pass percentage.
- Above the tables, a line says how many reports in the range could not be verified and were not counted.
- **Recent reports** with their status (Processed, Processing, Not verified, Over the daily limit, Rejected, Failed). A report still "Processing" after an hour is shown as too large to process on this plan: on the Workers Free plan a multi-megabyte XML can exceed the CPU limit. Typical reports from large providers are far smaller.

## Alerts

A daily job (02:00 UTC cron on Workers, the daily block of the Node scheduler) looks at domains that have reporting on. Spoofing and regression are evaluated **per verified reporter**, from that reporter's own rows only, with the source limit (2,000 sources) applied per reporter and at most 20 reporters of the day evaluated: reporters with history (distinct report days in the prior 30 days, most first) always come first and new reporters, busiest first, fill only the remaining slots, so fresh high-volume domains cannot push an established reporter out; the per-reporter results are merged into one alert per kind, each source tagged with its reporter. A forger therefore only ever affects its own buckets: its claim that an address passed for a month cannot hide another reporter's failures for that address.

| Alert | Rule |
|---|---|
| Possible spoofing | A source with at least 10 failing messages yesterday, from one reporter, that never passed in the prior 30 days of that reporter's reports. The five busiest are listed. |
| A source started failing | A source at 90% pass or better over at least 50 messages in the prior 30 days that fell below 50% pass on at least 10 messages yesterday, same reporter. |
| No reports | Reporting on for at least 3 days and no verified report for 7 days. At most one alert a week. |

Known limitation: the no-reports alert is domain-wide, so a report from *any* verified reporter (including an attacker who owns a DMARC-passing domain and names a contact in it) resets it. The attacker gains nothing else, but they can keep that one alert from firing. Evaluating it per expected reporter would need a list of who should report, which is not known.

Alerts appear on the page until acknowledged. A re-run never duplicates one. Optionally (off by default, per domain) the domain owner also gets a plain English email through the system mail sender, which needs a domain that can send.

The same job deletes reports, daily totals and acknowledged alerts older than 180 days, in batches (ids selected 500 at a time, deleted in groups of 90). Each table has its own per-run budget, at least one domain's maximum daily inflow: 12 batches (6,000 rows) of aggregates, 6 (3,000) of reports, 2 of alerts. Deletion is by `day` and by `received_at`, both indexed. With many domains near their daily maximum, a backlog can take more than one run to clear.

## Data

Tables `domain_deliverability`, `deliverability_reports`, `dmarc_daily_stats` and `deliverability_alerts` (migration sqlite `0098`, PostgreSQL and MySQL `0022`). All four are in backups and restore before their migration is applied. `dmarc_daily_stats` is backed up without its serial `id` (a PostgreSQL restore would leave the sequence behind explicit ids); its identity is the `(domain, day, row key)` unique key. No raw report XML is kept. Reports contain sender IP addresses and domain names, no message content, and no forensic (`ruf`) reports are requested.

TLS-RPT reports use the same address, parser limits and trust rules; see [mta-sts.md](mta-sts.md) for them and for MTA-STS. Report rows carry a `kind` (`dmarc` or `tlsrpt`) and every count on this page reads DMARC reports only.

Domain admins see the page and its routes (`/api/deliverability/[domainId]`, `/reports`, `/dmarc`, `/alerts/[alertId]`); each needs a session, the domain-admin permission, a domain you may manage and, for changes, a same-origin request.

## Known limitations

- **No-reports alert.** Any verified reporter resets it (see Alerts).
- **Workers Free plan.** The Free plan allows 10 ms of CPU per invocation. Parsing a multi-megabyte report XML, and gunzipping it, can exceed that and the invocation is killed. The report then stays `processing` (shown as too large for the plan after an hour) and is marked `failed` on redelivery; it is never retried into the same wall. Typical reports from large providers are far smaller, and the Paid plan has no such problem. The limits above bound the worst case but cannot make a large report cheap.
- **Subrequests.** Each reverse lookup is a subrequest (50 per invocation on Free). The per-report and per-batch lookup caps keep a batch of five reports well inside that; the database calls are not counted here because whether D1 calls count towards it has not been verified for this plan.
- **Yahoo.** Yahoo may send from `dmarc.yahoo.com` with a report contact at `yahooinc.com`; those organisations differ, so its reports would show as unverified. Not confirmed without a real Yahoo report.
- **Alert email volume.** One verified attacker can trigger at most one alert email per kind per day (alerts are deduplicated by domain, kind and day).
- **Budget races.** The daily budgets are counts read before writing, not atomic counters; concurrent consumers can overshoot a little.
- **Extra report caps.** Reports that pass DMARC are also capped at 300 per sending organisation and 2,000 in total per domain per day.
- **Alert evaluation.** Only reporters seen yesterday are evaluated, at most 20, history first.
- **Verified is about the sender, not the numbers.** A verified reporter can still send false counts about its own view of your mail; they are limited to their own buckets and budgets.
