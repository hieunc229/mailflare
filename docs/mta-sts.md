# MTA-STS and TLS reports

Two features that help other mail servers deliver to you over TLS and tell you when they could not. Both are **off by default**, per domain, and nothing changes until a domain admin turns them on under **Admin → Email → Deliverability** (the **TLS reports** and **MTA-STS** tabs).

- **TLS reports (TLS-RPT, RFC 8460).** Mail servers that send to you report each day how many TLS connections worked, how many failed and why. Mailflare reads these reports and shows daily totals.
- **MTA-STS (RFC 8461).** A policy file that tells senders to deliver to you only over TLS, and only to the mail servers it lists. Mailflare publishes the file and the DNS record.

Both are only for domain admins (the same permission as the DMARC page).

## TLS reports

TLS reports arrive at the same address as DMARC reports, `mailflare-reports@<your domain>`, so **DMARC reports must be on first** (the address, its Email Routing rule and its reserved local part belong to that switch), and DMARC reports cannot be turned off while TLS reports are on.

"Turn on TLS reports" adds `mailto:mailflare-reports@<domain>` to the `rua` of the TXT record at `_smtp._tls.<domain>`:

- No record: `v=TLSRPTv1; rua=mailto:<address>` is created.
- A record with other destinations (for example a reporting service): our address is appended to `rua`; every other destination and tag stays as it was.
- More than one TLS-RPT record: refused, remove the extra ones first.
- A zone that Mailflare does not manage (`manual`): the value to publish is shown.

"Turn off" removes only our address; a record that held nothing else is deleted. The setting changes only after DNS did. Unlike `_dmarc`, this edit is applied at once (it only adds or removes our own destination) and the page shows what changed.

### How a TLS report is handled

It goes through the same path as a DMARC report (see [dmarc-reports.md](dmarc-reports.md)): the kind is told apart by content (JSON or XML), the mail is stored and queued, the queue consumer parses it, the raw mail is deleted afterwards and only totals are kept. The same trust model applies: only a **verified reporter** (the report mail passed DMARC and its From organisation equals the organisation of the report's `contact-info` address) writes totals; every other report is only a row, shown as a count. The same daily caps (300 / 2,000 reports) and row budgets (1,000 per reporter, 5,000 per domain per day, shared with DMARC rows) apply, and a TLS report does not reset the "no DMARC reports" alert.

Report mail is attacker-controlled, so parsing is bounded (limits in `src/lib/deliverability/report-parse.ts`):

| Limit | Value |
|---|---|
| Report mail, compressed and decompressed size, expansion ratio | as for DMARC reports (5 MiB, 3 MiB, 8 MiB, 1000x); gzip or plain JSON, a zip is not accepted for JSON |
| JSON nesting | at most 8 levels, refused by a linear scan before `JSON.parse` |
| Policies per report | 1,000 |
| Failure details per policy | 100 |
| Session counts | whole numbers from 0 to 10,000,000, otherwise the report is rejected |
| Dates | RFC 3339, start at most 180 days back and one day ahead, at most 7 days long |
| Text fields | cut to the same lengths as DMARC fields; result types limited to `a-z 0-9 -` (anything else is shown as `other`) |
| Rows written per report | the 500 busiest (policy, mail server, result) rows |

A policy about another domain is ignored; a report with none of this domain's policies is rejected. Failures the summary counts but no detail names are shown as `unspecified`. No URL from a report is fetched and no reverse lookups are made.

The **TLS reports** tab shows sessions per day, why sessions failed, totals by policy and mail server (a failure names the host the reporter says failed, `receiving-mx-hostname`; everything else shows the policy's host pattern), by reporter, and the latest reports with their status.

## MTA-STS

### Publishing

"Publish in testing mode" on the **MTA-STS** tab:

1. Reads the domain's MX records and stores the host names (at most 20; none is refused, and so is an MX answer that is not a plain host name: leaving it out would make senders refuse that server, so you fix the record first. The null MX `.` is not a host). Hosts that are not Cloudflare Email Routing (`*.mx.cloudflare.net`) or SES inbound (`inbound-smtp.<region>.amazonaws.com`) are listed with a warning: Mailflare cannot check their certificates.
2. Writes the TXT record `_mta-sts.<domain>` = `v=STSv1; id=<YYYYMMDDHHMMSS>`, then stores the policy it announces. The id moves forward whenever the mode, the MX list or the cache time (`max_age`, one day to one year, default one week) changes, and not otherwise, so senders fetch the policy again exactly when it changed. DNS goes first so that a failed write changes nothing: a sender that fetched the policy in between and saw a rollback would hold a new mode under an old id and never ask again.
3. A record at `_mta-sts` that Mailflare did not publish is never overwritten: publishing is refused until you remove it. In a zone Mailflare does not manage, the TXT value is shown for you to publish.

The policy starts in **testing** mode: senders report problems (see the TLS tab) but still deliver. To switch to **enforce**, the page asks you to confirm that **every MX host presents a valid certificate for its own name**; in enforce mode senders refuse to deliver to a host that does not, so mail can be delayed or bounce. Read the TLS reports for a while first. Enforce needs testing first. The server refuses to publish a changed MX list while in enforce mode (and refuses to switch to enforce when the live MX list differs from the one that was watched): go back to testing, which publishes the new list under a new id, watch the reports, and switch again. The cache time can change in either mode.

### Changing the mail servers

While the policy is in **enforce**, senders refuse any MX host the policy does not list, so Mailflare refuses (409, in your language) every action that moves the MX: setting up or removing a receiving provider, switching the receiving provider, and the MX / SPF / DKIM-with-replace buttons. Switch MTA-STS to testing first. In **testing** mode these actions go through, and the policy is published again with the zone's MX list under a new id. The tab warns when the live MX records differ from the policy's list. You cannot delete a domain while a policy is published (testing, enforce, or the removal period): turn MTA-STS off and let the period end. Deleting also removes Mailflare's address from `_smtp._tls`, or waits for you to turn TLS reports off when it cannot (a zone Mailflare does not manage, or DNS refusing). A zone that Cloudflare no longer serves to the token (404 or 403) counts as a zone Mailflare does not manage: MTA-STS and TLS reports can still be turned off in the app (the policy is retired by the daily job), and the records are yours to remove.

If the policy cannot be run down (the zone is gone, DNS keeps failing), an administrator can **force the delete**: the domain page offers it when the delete is refused for MTA-STS or TLS reports, after typing the domain name. The API takes `DELETE /api/domains/[id]` (and `/api/v1/domains/[id]`) with `{ "force": true, "confirm": "<host name>" }`; a missing or different `confirm` is a 400. Mailflare tries to remove its `_mta-sts` record and its address in `_smtp._tls`, logs what fails, deletes the domain (and its mailboxes and mail) anyway, and writes an audit entry `domain.force_delete`. The answer is `{ ok, leftovers: [{ name, type }], cachedUntil }`: the DNS records you must remove by hand (always the `mta-sts` host record you created, plus any record Mailflare could not remove) and the latest date senders may still apply the cached policy. Until then, in enforce mode, senders refuse mail to an MX host the cached policy does not list.

### Attaching the policy host

Senders fetch `https://mta-sts.<domain>/.well-known/mta-sts.txt`. **Mailflare does not create this host for you** (no Workers Custom Domain or route is created automatically); you attach it once per domain:

- **Cloudflare Workers.** Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom domain → `mta-sts.<domain>`. Cloudflare issues the certificate; it can take a few minutes. (The same step as the read-receipt host.)
- **Docker.** Point `mta-sts.<domain>` at the server and route it to the container with a certificate, for example with Caddy:

  ```
  mta-sts.example.com {
  	reverse_proxy mailflare:3000
  }
  ```

  The proxy must pass the `Host` header on (Caddy's `reverse_proxy` does).

The **Check the host** button fetches the policy from your browser and compares it with what Mailflare expects. A redirect counts as a failure (RFC 8461 forbids redirects). The result is recorded as "checked on <date>"; it is informational and changes nothing that is served.

### What the host serves

The same app serves every host, so `mta-sts.*` hosts are guarded (`guardMtaStsHost` in `worker.ts` and `server/index.ts`): on such a host only `GET` and `HEAD` of `/.well-known/mta-sts.txt` reach the app; every other path is a 404 and every other method a 405, so the login page and the APIs are never served there. The policy is answered only for `mta-sts.<domain>` where `<domain>` is a managed domain with a published policy (testing, enforce, or the removal period below); any other host, including the app's own, gets a 404. The body is built from stored values that are validated again on every request (mode, MX host names, `max_age`) and never contains anything from the request. The response is `text/plain; charset=utf-8`, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *` (public data; the browser check needs it) and `X-Content-Type-Options: nosniff`, and it never redirects. On Workers that host opens no database read session, so the answer carries no cookie.

### Turning it off

RFC 8461 asks for a removal period: "Turn off MTA-STS" publishes a policy with `mode: none` under a new id and keeps serving it for the longest `max_age` any policy of this run was served with (the stored `mta_sts_served_max_age`, so lowering the cache time does not shorten the wait), so senders that cached your policy stop enforcing it. The daily job (02:00 UTC) then deletes the `_mta-sts` record and clears the policy; the host answers 404 from then on. A failed record delete is tried again the next day. In a zone Mailflare does not manage the policy is cleared and the tab tells you to delete the TXT record yourself after the date shown. Publishing again during the removal period cancels it.

## Data

Columns on `domain_deliverability` (`tls_rpt_enabled`, `mta_sts_mode`, `mta_sts_policy_id`, `mta_sts_mx`, `mta_sts_max_age`, `mta_sts_served_max_age`, `mta_sts_verified_at`, `mta_sts_retire_after`), a `kind` column on `deliverability_reports` (`dmarc` or `tlsrpt`) and the table `tls_daily_stats` (migration sqlite `0100`, PostgreSQL and MySQL `0024`). `tls_daily_stats` has one row per day, verified reporter, policy type, mail server and result type, with integer counts, and is backed up without its serial `id` like `dmarc_daily_stats`. Retention is 180 days. Backups from a migrated database restore onto a database that has not applied the migration yet (the unknown columns are dropped).

Before the migration is applied, report mail is dropped with a log line (providers send reports again), the policy host answers 404 and the routes answer 409 `MIGRATION_REQUIRED`.

## Known limitations

- **Alerts.** There is no alert for TLS failures yet.
- **Host check.** The "checked" status is a claim made by the admin's browser; nothing on the server verifies it.
- **Workers Free plan.** The CPU caveat of [dmarc-reports.md](dmarc-reports.md) applies to TLS reports too; they are normally small.
- **Several domains with the same host name.** If two accounts own the same host name, the first published policy is served.
- **Manual zones.** Mailflare cannot publish or remove records; it shows the values.
