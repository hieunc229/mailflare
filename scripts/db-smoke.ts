/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, domains, mailboxes, messages, calendarEvents, contacts, contactDetails, davCards, davCollections, folders, jmapChanges, appSettings, webhooks, spamTokenStats, spamReputation, mailboxPromotionSettings, emailSuppressions, domainDeliverability, imapMessageFlags } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { importCalendarGroups } from "@/lib/calendar/import-store";
import { importContacts } from "@/lib/contacts/import-store";
import { exportDatabaseRecords, restoreDatabaseRecords } from "@/lib/backups/export";
import { getSearchIndexStatus } from "@/lib/search/index-admin";
import { recordReputationObservation } from "@/lib/spam/repository";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { listSubscriptions } from "@/lib/promotions/subscriptions";
import { runPromotionsBackfill, selectBackfillCandidates } from "@/lib/promotions/backfill";
import { recordSuppression } from "@/lib/deliverability/suppression";
import { ingestReportMail } from "@/lib/deliverability/ingest";
import { runDeliverabilityDaily } from "@/lib/deliverability/daily";
import { getDmarcStats } from "@/lib/deliverability/dmarc-stats";
import { getTlsStats } from "@/lib/deliverability/tls-stats";
import { markMtaStsVerified, updateMtaSts, type MtaStsDeps } from "@/lib/deliverability/mta-sts-admin";
import { assertDomainRemovable, assertMxChangeAllowed } from "@/lib/deliverability/mta-sts-guard";
import { serveMtaStsPolicy } from "@/lib/deliverability/mta-sts-serve";
import { gzipSync } from "node:zlib";
import { syncMailbox } from "@/lib/imap/sync";
import { pruneImapExpunged } from "@/lib/imap/expunge-prune";
import { changedSince, maxModseqOf, modseqsOf, vanishedSince } from "@/lib/imap/condstore";
import { unchangedSinceLogged } from "@/lib/jmap/emails";
import { FolderView } from "@/lib/imap/view";

const [url, driver] = process.argv.slice(2);
if (!url) throw new Error("usage: db-smoke <DATABASE_URL> [driver]");

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
	checks.push([name, ok]);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const config = getDatabaseConfig({ DATABASE_URL: url, DATABASE_DRIVER: driver } as never);
const external = openExternalDatabase(config, true);
const d1 = external as unknown as D1Database;
console.log(`dialect=${config.dialect} driver=${config.driver}`);

const applied = await applyPendingMigrations(d1);
check("migrations apply", applied.ready && applied.applied.length > 0);
check("migrations idempotent", (await applyPendingMigrations(d1)).applied.length === 0 && (await getMigrationStatus(d1)).ready);

const db = createDb(d1);
const stamp = Date.now();
const userId = `usr_${stamp}`;
await db.insert(users).values({ id: userId, email: `a${stamp}@example.com`, passwordHash: "x", name: "A" });
const [user] = await db.select().from(users).where(eq(users.id, userId));
check("insert + select", user?.email === `a${stamp}@example.com` && user.createdAt instanceof Date && user.disabled === false);
check("timestamp is a recent Date", Math.abs(user.createdAt.getTime() - Date.now()) < 60_000);

await db.insert(domains).values({ id: `dom_${stamp}`, userId, hostname: `${stamp}.example.com`, zoneId: "z" });
await db.insert(mailboxes).values({ id: `mbx_${stamp}`, userId, domainId: `dom_${stamp}`, localPart: "me" });
await db.insert(messages).values({ id: `msg_${stamp}`, userId, mailboxId: `mbx_${stamp}`, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Quarterly Report", textBody: "numbers inside", status: "received" } as never);
const changes = await db.select().from(jmapChanges).where(eq(jmapChanges.mailboxId, `mbx_${stamp}`));
check("trigger wrote jmap_changes", changes.length >= 1 && changes[0].change === "created");
const revisions = await db.all<{ revision: number }>(sql`SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = ${`mbx_${stamp}`}`);
check("trigger bumped jmap revision", Number(revisions[0]?.revision) >= 1);

await db.update(messages).set({ status: "trash" }).where(eq(messages.id, `msg_${stamp}`));
const [trashed] = await db.select({ trashedAt: messages.trashedAt, status: messages.status }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("trigger set trashed_at", trashed.status === "trash" && trashed.trashedAt instanceof Date);
await db.update(messages).set({ status: "received" }).where(eq(messages.id, `msg_${stamp}`));
const [restored] = await db.select({ trashedAt: messages.trashedAt }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("trigger cleared trashed_at", restored.trashedAt === null);

const claimed = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, `msg_${stamp}`), eq(messages.starred, false))).returning({ id: messages.id });
check("update returning (claim)", claimed.length === 1 && claimed[0].id === `msg_${stamp}`);
const lost = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, `msg_${stamp}`), eq(messages.starred, false))).returning({ id: messages.id });
check("update returning (lost claim)", lost.length === 0);

const inserted = await db.insert(folders).values({ id: `fld_${stamp}`, userId, mailboxId: `mbx_${stamp}`, name: "F" } as never).onConflictDoNothing().returning({ id: folders.id });
check("insert onConflictDoNothing returning", inserted.length === 1);
const duplicate = await db.insert(folders).values({ id: `fld_${stamp}`, userId, mailboxId: `mbx_${stamp}`, name: "F" } as never).onConflictDoNothing().returning({ id: folders.id });
check("insert onConflictDoNothing (duplicate)", duplicate.length === 0);

await db.insert(spamTokenStats).values({ mailboxId: `mbx_${stamp}`, token: "t", spamCount: 1, hamCount: 0, updatedAt: new Date() } as never)
	.onConflictDoUpdate({ target: [spamTokenStats.mailboxId, spamTokenStats.token], set: { spamCount: sql`${spamTokenStats.spamCount} + 1` } });
await db.insert(spamTokenStats).values({ mailboxId: `mbx_${stamp}`, token: "t", spamCount: 1, hamCount: 0, updatedAt: new Date() } as never)
	.onConflictDoUpdate({ target: [spamTokenStats.mailboxId, spamTokenStats.token], set: { spamCount: sql`${spamTokenStats.spamCount} + 1` } });
const [stat] = await db.select().from(spamTokenStats).where(eq(spamTokenStats.mailboxId, `mbx_${stamp}`));
check("upsert increments", stat?.spamCount === 2);

const [{ n }] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE mailbox_id = ${`mbx_${stamp}`}`);
check("raw sql all()", Number(n) === 1);
const run = await db.run(sql`UPDATE messages SET starred = ${false} WHERE id = ${`msg_${stamp}`}`);
check("raw sql run() reports changes", (run as { meta: { changes: number } }).meta.changes === 1);

await db.batch([
	db.update(messages).set({ subject: "batched" }).where(eq(messages.id, `msg_${stamp}`)),
	db.insert(webhooks).values({ id: `wh_${stamp}`, userId, url: "https://example.com", secret: "s", events: "[]" } as never),
] as never);
const [batched] = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("batch", batched.subject === "batched");

const prepared = await d1.prepare("SELECT count(*) AS n FROM messages WHERE mailbox_id = ?").bind(`mbx_${stamp}`).first<{ n: number }>();
check("D1-compatible prepare().bind().first()", Number(prepared?.n) === 1);
const batchResults = await d1.batch([d1.prepare("SELECT 1 AS one"), d1.prepare("SELECT 2 AS two")]);
check("D1-compatible batch()", batchResults.length === 2);

await db.update(messages).set({ subject: "Quarterly Report" }).where(eq(messages.id, `msg_${stamp}`));
for (const [query, expected] of [["quarterly", 1], ["subject:report", 1], ["from:x@y.z numbers", 1], ["absent-term", 0], ["-quarterly", 0]] as const) {
	const found = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, `mbx_${stamp}`), ...buildSearchConditions(query)));
	check(`search "${query}"`, found.length === expected);
}

const env = { DB: d1 } as unknown as CloudflareEnv;
const event = { hostIds: [userId], name: "Intro", location: "Zoom", color: "blue", timeZone: "UTC" } as never;
const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const endsAt = new Date(Date.now() + 86_400_000 + 1_800_000).toISOString();
check("booking inserts", (await createBookedCalendarEvents(env, event, "Guest", "g@example.com", startsAt, endsAt)) === true);
check("booking refuses a busy slot", (await createBookedCalendarEvents(env, event, "Guest", "g@example.com", startsAt, endsAt)) === false);

const importGroups = Array.from({ length: 9 }, (_, n) => ["BEGIN:VEVENT", `UID:smoke-${n}@google.com`, "DTSTART:20261104T090000Z", "RRULE:FREQ=DAILY", `SUMMARY:Imported ${n}`, "END:VEVENT"].join("\r\n"));
const importInput = { userId, userZone: "UTC", ownAddresses: [], color: "#16a34a", reminders: true, skipDeclined: true, groups: importGroups };
const firstImport = await importCalendarGroups(db, importInput);
check("calendar import inserts", firstImport.imported === 9 && firstImport.failed === 0);
const secondImport = await importCalendarGroups(db, importInput);
check("calendar import is idempotent", secondImport.imported === 0 && secondImport.skipped === 9);
const importedRows = await db.select({ id: calendarEvents.id, repeat: calendarEvents.repeat, mailboxId: calendarEvents.mailboxId }).from(calendarEvents).where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.title, "Imported 3")));
check("imported event is a plain daily series", importedRows.length === 1 && importedRows[0].repeat === "daily" && importedRows[0].mailboxId === null && importedRows[0].id.startsWith("ics_"));
// CalDAV/CardDAV change log: the dav_changes_* triggers must agree on every dialect (MySQL compares text case-insensitively unless told otherwise).
const davEventId = `evt_${stamp}`;
const davLog = async (collection: string, key: string) => (await db.all<{ change_type: string }>(sql`SELECT change_type FROM dav_changes WHERE collection_id = ${collection} AND object_key = ${key} ORDER BY seq`)).map((row) => row.change_type).join(",");
await db.insert(calendarEvents).values({ id: davEventId, userId, title: "Standup", startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } as never);
check("dav trigger logs an inserted event", (await davLog(`cal:${userId}`, davEventId)) === "created");
await db.update(calendarEvents).set({ title: "standup" }).where(eq(calendarEvents.id, davEventId));
check("dav trigger sees a case-only title change", (await davLog(`cal:${userId}`, davEventId)) === "created,updated");
await db.update(calendarEvents).set({ lastRemindedStart: new Date() }).where(eq(calendarEvents.id, davEventId));
await db.update(calendarEvents).set({ title: "standup" }).where(eq(calendarEvents.id, davEventId));
check("dav trigger ignores reminder bookkeeping and no-op updates", (await davLog(`cal:${userId}`, davEventId)) === "created,updated");
await db.insert(davCollections).values({ id: `card:${userId}`, userId, kind: "addressbook" } as never);
await db.insert(davCards).values({ id: `card_${stamp}`, userId, collectionId: `card:${userId}`, name: "a.vcf", uid: "uid-1", body: "BEGIN:VCARD", version: "3.0", size: 11 } as never);
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs card create and update", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ body: "BEGIN:VCARD\nEND:VCARD" }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger ignores a card update that changes nothing", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated");
await db.update(davCards).set({ collectionId: `card:${userId}-moved` }).where(eq(davCards.id, `card_${stamp}`));
check("dav trigger logs a card moved between collections", (await davLog(`card:${userId}`, `card_${stamp}`)) === "created,updated,destroyed" && (await davLog(`card:${userId}-moved`, `card_${stamp}`)) === "created");

const contactBody = { mailboxId: `mbx_${stamp}`, format: "vcard" as const, items: [
	{ vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Smoke Person\nEMAIL:smoke-a@example.com\nEMAIL:smoke-b@example.com\nTEL:+1 555 0100\nORG:Acme\nEND:VCARD", hasPhoto: true },
	{ vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:No Mail\nEND:VCARD", hasPhoto: false },
] };
const firstContacts = await importContacts(db, { userId, body: contactBody });
check("contact import inserts one contact per address", firstContacts.created === 2 && firstContacts.noEmail === 1 && firstContacts.photoTargets.join() === "smoke-a@example.com");
const secondContacts = await importContacts(db, { userId, body: contactBody });
check("contact import is idempotent", secondContacts.created === 0 && secondContacts.updated === 0 && secondContacts.unchanged === 2);
const importedContact = await db.select({ name: contacts.displayName, source: contacts.source, details: contactDetails.details }).from(contacts).innerJoin(contactDetails, eq(contactDetails.contactId, contacts.id)).where(eq(contacts.id, `${userId}:smoke-b@example.com`));
check("imported contact keeps its details", importedContact.length === 1 && importedContact[0].name === "Smoke Person" && importedContact[0].source === "import" && JSON.parse(importedContact[0].details).organization === "Acme");
await db.delete(contacts).where(eq(contacts.id, `${userId}:smoke-a@example.com`));
check("deleting a contact removes its details", (await db.select().from(contactDetails).where(eq(contactDetails.contactId, `${userId}:smoke-a@example.com`))).length === 0);
const ownPhoto = await importContacts(db, { userId, body: { mailboxId: `mbx_${stamp}`, format: "vcard", items: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Me\nEMAIL:me@${stamp}.example.com\nEND:VCARD`, hasPhoto: true }] } });
check("an own identity address is never a photo target", ownPhoto.created === 1 && ownPhoto.photoTargets.length === 0);

await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }, { type: "email", key: "x@y.z" }] as never);
await recordReputationObservation(env, `mbx_${stamp}`, [{ type: "domain", key: "example.com" }] as never);
const reputation = await db.select().from(spamReputation).where(and(eq(spamReputation.mailboxId, `mbx_${stamp}`), eq(spamReputation.key, "example.com")));
check("spam reputation upsert", reputation[0]?.messagesSeen === 2);

const suppressed = { domainId: `dom_${stamp}`, email: "a@x.org" };
await recordSuppression(env, { ...suppressed, reason: "manual", source: "admin", detail: "note" });
await recordSuppression(env, { ...suppressed, reason: "hard_bounce", source: "ses", detail: "550" });
await recordSuppression(env, { ...suppressed, reason: "complaint", source: "resend" });
await recordSuppression(env, { ...suppressed, reason: "hard_bounce", source: "ses", detail: "again" });
const [suppression] = await db.select().from(emailSuppressions).where(eq(emailSuppressions.domainId, suppressed.domainId));
check("suppression upsert keeps the strongest reason and counts events", suppression?.reason === "complaint" && suppression.source === "resend" && suppression.eventCount === 4);

const returned = { domainId: `dom_${stamp}`, email: "dsn@x.org", reason: "hard_bounce" as const, source: "dsn" as const, confirmed: false };
const confirmedOf = async () => (await db.select().from(emailSuppressions).where(and(eq(emailSuppressions.domainId, returned.domainId), eq(emailSuppressions.email, returned.email))))[0]?.confirmed;
await recordSuppression(env, { ...returned, evidenceRef: "m1" });
await recordSuppression(env, { ...returned, evidenceRef: "m1" });
const sameMessage = await confirmedOf();
await recordSuppression(env, { ...returned, evidenceRef: "m2" });
check("a DSN is confirmed only by a second, different original message", sameMessage === false && await confirmedOf() === true);

// DMARC report ingest: report row, aggregate upserts in batches, and the stats queries, on this dialect.
const reportDay = Math.floor(Date.now() / 1000) - 3600;
const reportXml = (reportId: string) => `<feedback><report_metadata><org_name>google.com</org_name><email>r@google.com</email><report_id>${reportId}</report_id><date_range><begin>${reportDay}</begin><end>${reportDay + 3600}</end></date_range></report_metadata><policy_published><domain>smoke.test</domain><p>none</p><pct>100</pct></policy_published><record><row><source_ip>203.0.113.7</source_ip><count>40</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>smoke.test</header_from></identifiers></record><record><row><source_ip>198.51.100.9</source_ip><count>2</count><policy_evaluated><disposition>reject</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>smoke.test</header_from></identifiers></record></feedback>`;
const reportMime = (reportId: string) => Buffer.from(`From: r@google.com\r\nTo: mailflare-reports@smoke.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/gzip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="r.xml.gz"\r\n\r\n${Buffer.from(gzipSync(reportXml(reportId))).toString("base64")}\r\n--b--\r\n`);
const reportObjects = new Map<string, Buffer>();
const reportEnv = { DB: d1, BUCKET: { get: async (key: string) => { const bytes = reportObjects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } : null; }, delete: async (key: string) => { reportObjects.delete(key); } } } as unknown as CloudflareEnv;
const reportTarget = { domainId: `dom_${stamp}`, hostname: "smoke.test" };
for (const [key, id] of [["raw1", `r1_${stamp}`], ["raw2", `r2_${stamp}`], ["raw1", `r1_${stamp}`]] as const) {
	reportObjects.set(key, reportMime(id));
	await ingestReportMail(reportEnv, reportTarget, { rawR2Key: key, authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
}
const dmarc = await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 });
const dmarcTotal = (key: "pass" | "rejected") => dmarc.series.reduce((sum, day) => sum + day[key], 0);
check("dmarc ingest adds counts across reports and ignores a redelivery", dmarcTotal("pass") === 80 && dmarcTotal("rejected") === 4 && dmarc.sources.length === 2 && dmarc.reporters[0]?.reports === 2);

// TLS-RPT ingest: same path, the upsert adds integer counts, a redelivery changes nothing.
const tlsJson = (reportId: string) => JSON.stringify({ "organization-name": "Google Inc.", "date-range": { "start-datetime": new Date(reportDay * 1000).toISOString(), "end-datetime": new Date((reportDay + 3600) * 1000).toISOString() }, "contact-info": "smtp-tls-reporting@google.com", "report-id": reportId, policies: [{ policy: { "policy-type": "sts", "policy-domain": "smoke.test", "mx-host": ["mx.smoke.test"] }, summary: { "total-successful-session-count": 10, "total-failure-session-count": 2 }, "failure-details": [{ "result-type": "certificate-expired", "failed-session-count": 2 }] }] });
const tlsMime = (reportId: string) => Buffer.from(`From: smtp-tls-reporting@google.com\r\nTo: mailflare-reports@smoke.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/tlsrpt+gzip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="r.json.gz"\r\n\r\n${Buffer.from(gzipSync(tlsJson(reportId))).toString("base64")}\r\n--b--\r\n`);
for (const [key, id] of [["tls1", `t1_${stamp}`], ["tls2", `t2_${stamp}`], ["tls1", `t1_${stamp}`]] as const) {
	reportObjects.set(key, tlsMime(id));
	await ingestReportMail(reportEnv, reportTarget, { rawR2Key: key, authenticated: true, from: "smtp-tls-reporting@google.com" }, { lookupPtr: async () => null });
}
const tls = await getTlsStats(reportEnv, reportTarget.domainId, { days: 7 });
check("tls-rpt ingest adds counts across reports and ignores a redelivery", tls.series.reduce((sum, day) => sum + day.success, 0) === 20 && tls.series.reduce((sum, day) => sum + day.failure, 0) === 4 && tls.failureTypes[0]?.resultType === "certificate-expired" && tls.failureTypes[0].failure === 4 && tls.recentReports.length === 2);
check("dmarc stats ignore tls-rpt reports", (await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 })).recentReports.every((report) => report.reporterOrg === "google.com") && dmarcTotal("pass") === 80);

// MTA-STS: publish, serve through the host-keyed join, mark checked, then the removal period and the daily retirement.
const stsDomain = { id: `dom_${stamp}`, hostname: `${stamp}.example.com`, zoneId: "z" };
let stsRecord: string | null = null;
const stsDeps: MtaStsDeps = {
	listTxt: async () => (stsRecord ? [{ id: "r1", content: stsRecord }] : []),
	queryTxt: async () => (stsRecord ? [stsRecord] : []),
	createTxt: async (_env, _zone, _name, content) => { stsRecord = content; },
	updateTxt: async (_env, _zone, _id, content) => { stsRecord = content; },
	deleteTxt: async () => { stsRecord = null; },
	ensureRoute: async () => undefined,
	deleteRoute: async () => undefined,
	queryMx: async () => ["10 route1.mx.cloudflare.net."],
	zoneMx: async () => ["10 route1.mx.cloudflare.net."],
};
const published = await updateMtaSts(reportEnv, stsDomain, { mode: "testing" }, stsDeps);
const policyRequest = () => new Request(`https://mta-sts.${stsDomain.hostname}/.well-known/mta-sts.txt`);
const served = await serveMtaStsPolicy(reportEnv, policyRequest());
check("mta-sts publishes and serves the stored policy", published.kind === "ok" && served.status === 200 && (await served.text()).includes("mx: route1.mx.cloudflare.net") && String(stsRecord).startsWith("v=STSv1; id="));
const checked = await markMtaStsVerified(reportEnv, stsDomain);
check("mta-sts records the browser check", checked.kind === "ok" && checked.state.verifiedAt !== null);
const enforced = await updateMtaSts(reportEnv, stsDomain, { mode: "enforce", acknowledgeRisk: true }, stsDeps, new Date(Date.now() + 2000));
check("mta-sts switches to enforce with a new id", enforced.kind === "ok" && published.kind === "ok" && enforced.state.mode === "enforce" && enforced.state.policyId !== published.state.policyId);
const changedMx = await updateMtaSts(reportEnv, stsDomain, { mode: "enforce", acknowledgeRisk: true }, { ...stsDeps, queryMx: async () => ["10 other.smoke.test."] }, new Date(Date.now() + 3000));
check("mta-sts refuses a changed MX list while enforce", changedMx.kind === "error" && changedMx.code === "MX_CHANGED_IN_ENFORCE");
const blockedMx = await assertMxChangeAllowed(reportEnv, stsDomain).then(() => null, (error: unknown) => (error as { code?: string }).code);
const blockedDelete = await assertDomainRemovable(reportEnv, stsDomain, stsDeps).then(() => null, (error: unknown) => (error as { code?: string }).code);
check("mta-sts blocks MX changes in enforce and domain deletion while published", blockedMx === "MTA_STS_ENFORCED" && blockedDelete === "MTA_STS_PUBLISHED");
const retiring = await updateMtaSts(reportEnv, stsDomain, { mode: "none" }, stsDeps, new Date(Date.now() + 4000));
check("mta-sts removal serves mode none", retiring.kind === "ok" && retiring.state.status === "retiring" && (await (await serveMtaStsPolicy(reportEnv, policyRequest())).text()).includes("mode: none"));

await db.insert(domainDeliverability).values({ domainId: reportTarget.domainId, reportsEnabled: true, reportsEnabledAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
await runDeliverabilityDaily(reportEnv, new Date(), { sendMail: async () => true, mtaStsDeps: stsDeps });
check("mta-sts is still served before the removal period ends", (await serveMtaStsPolicy(reportEnv, policyRequest())).status === 200);
await runDeliverabilityDaily(reportEnv, new Date(Date.now() + 200 * 86_400_000), { sendMail: async () => true, mtaStsDeps: stsDeps });
check("mta-sts retires after the removal period: record deleted, host answers 404", (stsRecord as string | null) === null && (await serveMtaStsPolicy(reportEnv, policyRequest())).status === 404);
const leftover = await db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM dmarc_daily_stats WHERE domain_id = ${reportTarget.domainId}) + (SELECT count(*) FROM tls_daily_stats WHERE domain_id = ${reportTarget.domainId}) + (SELECT count(*) FROM deliverability_reports WHERE domain_id = ${reportTarget.domainId}) AS n`);
check("deliverability daily job purges data past retention", Number(leftover[0].n) === 0);

try {
	await db.insert(users).values({ id: `usr2_${stamp}`, email: `a${stamp}@example.com`, passwordHash: "x", name: "B" });
	check("unique violation throws", false);
} catch (error) {
	check("unique violation is recognised", isUniqueConstraintError(error));
}

const searchStatus = await getSearchIndexStatus(env);
check("search index status", searchStatus.messages === searchStatus.indexed && searchStatus.messages >= 1);

// Promotions: the grouped Subscriptions query (group by, count distinct, sum(case), batched latest-message selects)
// and the backfill (claim, keyset select, batched updates, fenced save) in this dialect.
const promo = { id: `pro_${stamp}`, base: { userId, mailboxId: `mbx_${stamp}`, direction: "inbound", toAddr: "me@example.com", status: "received" } };
await db.insert(messages).values([
	{ ...promo.base, id: `${promo.id}_1`, fromAddr: "Acme <news@acme.com>", senderAddress: "news@acme.com", category: "promotions", hasUnsubscribe: true, read: true },
	{ ...promo.base, id: `${promo.id}_2`, fromAddr: "Acme <news@acme.com>", senderAddress: "news@acme.com", category: "promotions", hasUnsubscribe: true },
	{ ...promo.base, id: `${promo.id}_3`, fromAddr: "Shop <deals@shop.com>", senderAddress: "deals@shop.com", category: "promotions" },
	{ ...promo.base, id: `${promo.id}_4`, fromAddr: "Late <late@news.com>", hasUnsubscribe: true, rawR2Key: `raw/${promo.id}_4` },
] as never);
const subscriptions = await listSubscriptions(db, { mailboxId: `mbx_${stamp}`, offset: 0, limit: 50 });
check("subscriptions grouped query", subscriptions.total === 2 && subscriptions.senders[0]?.senderAddress === "news@acme.com" && subscriptions.senders[0].total === 2 && subscriptions.senders[0].readRate === 50 && subscriptions.senders[0].canUnsubscribe && subscriptions.senders[0].lastReceived instanceof Date && subscriptions.senders[1]?.latestMessageId === `${promo.id}_3`);
await db.insert(mailboxPromotionSettings).values({ mailboxId: `mbx_${stamp}`, mode: "show", backfillStatus: "pending" } as never);
const candidates = await selectBackfillCandidates(db, { mailboxId: `mbx_${stamp}`, cursor: null, now: new Date() });
check("backfill candidate select", candidates.length === 1 && candidates[0].id === `${promo.id}_4`);
const bucket = { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode("List-Unsubscribe: <mailto:u@late.com>\r\n\r\nbody").buffer }) };
const backfilled = await runPromotionsBackfill({ DB: d1, BUCKET: bucket } as unknown as CloudflareEnv, new Date());
const [late] = await db.select({ category: messages.category, senderAddress: messages.senderAddress }).from(messages).where(eq(messages.id, `${promo.id}_4`));
const [progress] = await db.select().from(mailboxPromotionSettings).where(eq(mailboxPromotionSettings.mailboxId, `mbx_${stamp}`));
check("backfill claims, classifies and saves", backfilled.claimed && late.category === "promotions" && late.senderAddress === "late@news.com" && progress.backfillStatus === "done" && progress.backfillScanned === 1 && progress.backfillStalls === 0);

// An aggregate row that exists when the backup is taken: dmarc_daily_stats has a serial id that must not be backed up.
reportObjects.set("raw4", reportMime(`r4_${stamp}`));
await ingestReportMail(reportEnv, reportTarget, { rawR2Key: "raw4", authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
// IMAP state: the sync engine's own query shapes (conditional counter update, anti-join reconcile, multi-row insert, batch).
const imapMailbox = `imbx_${stamp}`;
await db.insert(mailboxes).values({ id: imapMailbox, userId, domainId: `dom_${stamp}`, localPart: "imap" });
await db.insert(messages).values({ id: `imsg_${stamp}`, userId, mailboxId: imapMailbox, direction: "inbound", fromAddr: "x@y.z", toAddr: "imap@example.com", subject: "Quarterly Report", textBody: "numbers inside", status: "received" } as never);
await syncMailbox(env, imapMailbox);
const imapUids = () => db.all<{ uid: number; message_id: string; folder_key: string }>(sql`SELECT uid, message_id, folder_key FROM imap_uids WHERE mailbox_id = ${imapMailbox} ORDER BY folder_key, uid`);
check("imap reconcile assigns a UID (anti-join, multi-row insert)", (await imapUids()).length === 1 && Number((await imapUids())[0].uid) === 1 && (await imapUids())[0].folder_key === "inbox");
const [folderCounters] = await db.all<{ uid_next: number; modseq: number }>(sql`SELECT f.uid_next AS uid_next, m.modseq AS modseq FROM imap_folder_state f JOIN imap_mailbox_state m ON m.mailbox_id = f.mailbox_id WHERE f.id = ${`${imapMailbox}:inbox`}`);
check("imap counters are reserved in the batch that uses them (derived UID and modseq)", Number(folderCounters.uid_next) === 2 && Number(folderCounters.modseq) >= 2);
await db.update(messages).set({ status: "archived" }).where(eq(messages.id, `imsg_${stamp}`));
await syncMailbox(env, imapMailbox);
const movedUids = await imapUids();
const expungedRows = await db.all<{ uid: number }>(sql`SELECT uid FROM imap_expunged WHERE mailbox_id = ${imapMailbox} AND folder_key = 'inbox'`);
check("imap move expunges and assigns a new UID (change-log sync)", movedUids.length === 1 && movedUids[0].folder_key === "archive" && expungedRows.length === 1);
await db.run(sql`DELETE FROM imap_mailbox_state WHERE mailbox_id = ${imapMailbox}`);
await syncMailbox(env, imapMailbox);
check("imap reconcile is idempotent", (await imapUids()).length === 1);
await db.update(messages).set({ status: "received" }).where(eq(messages.id, `imsg_${stamp}`));

// IMAP writes: the flag upsert with the message touch (one batch), the expunge candidate join, the unflag update, the UID lookup and the conditional move and delete.
const flagsMessage = `imsg_${stamp}`;
await syncMailbox(env, imapMailbox);
const [beforeFlags] = await db.all<{ modseq: number }>(sql`SELECT modseq FROM imap_uids WHERE mailbox_id = ${imapMailbox} AND message_id = ${flagsMessage}`);
const flagValues = { answered: true, forwarded: false, deleted: true, keywords: '["Orders"]', updatedAt: Math.floor(Date.now() / 1000) };
await db.batch([
	db.insert(imapMessageFlags).values({ messageId: flagsMessage, ...flagValues }).onConflictDoUpdate({ target: imapMessageFlags.messageId, set: flagValues }),
	db.update(messages).set({ read: sql`${messages.read}` }).where(and(eq(messages.id, flagsMessage), eq(messages.mailboxId, imapMailbox))),
] as never);
await syncMailbox(env, imapMailbox);
const [afterFlags] = await db.all<{ modseq: number }>(sql`SELECT modseq FROM imap_uids WHERE mailbox_id = ${imapMailbox} AND message_id = ${flagsMessage}`);
check("imap flag write gives the UID a later mod-sequence (upsert plus touch)", Number(afterFlags.modseq) > Number(beforeFlags.modseq));
const expungeCandidates = (await d1.prepare("SELECT u.uid AS uid, u.message_id AS message_id FROM imap_uids u INNER JOIN imap_message_flags f ON f.message_id = u.message_id WHERE u.mailbox_id = ? AND u.folder_key = ? AND f.deleted = ? ORDER BY u.uid LIMIT ?").bind(imapMailbox, "inbox", true, 10).all<{ uid: number; message_id: string }>()).results;
check("imap expunge candidates (join on the \\Deleted flag)", expungeCandidates.length === 1 && expungeCandidates[0].message_id === flagsMessage);
await d1.prepare("UPDATE imap_message_flags SET deleted = ? WHERE message_id IN (?, ?)").bind(false, flagsMessage, "none").run();
const [unflagged] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_message_flags WHERE message_id = ${flagsMessage} AND NOT deleted`);
check("imap unflag update", Number(unflagged.n) === 1);
const looked = (await d1.prepare("SELECT message_id, uid FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND message_id IN (?, ?)").bind(imapMailbox, "inbox", flagsMessage, "none").all<{ message_id: string; uid: number }>()).results;
check("imap UID lookup by message ids", looked.length === 1 && Number(looked[0].uid) >= 1);
await db.run(sql`DELETE FROM imap_message_flags WHERE message_id = ${flagsMessage}`);
const guarded = `msg_guard_${stamp}`;
await db.insert(messages).values({ id: guarded, userId, mailboxId: imapMailbox, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Guarded", textBody: "body", status: "trash" } as never);
const movedWrong = await db.update(messages).set({ status: "trash", folderId: null }).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
const deletedWrong = await db.delete(messages).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
check("imap conditional move and delete skip a row that changed", movedWrong.length === 0 && deletedWrong.length === 0);
const movedRight = await db.update(messages).set({ status: "archived", folderId: null }).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "trash"), isNull(messages.folderId))).returning({ id: messages.id });
const deletedRight = await db.delete(messages).where(and(eq(messages.id, guarded), eq(messages.mailboxId, imapMailbox), eq(messages.status, "archived"), isNull(messages.folderId))).returning({ id: messages.id });
check("imap conditional move and delete return the rows they changed", movedRight.length === 1 && deletedRight.length === 1);

// IMAP STORE UNCHANGEDSINCE: the write is conditional on the change log, in the statement that writes.
const logged = `msg_log_${stamp}`;
await db.insert(messages).values({ id: logged, userId, mailboxId: imapMailbox, direction: "inbound", fromAddr: "x@y.z", toAddr: "me@example.com", subject: "Logged", textBody: "body", status: "received" } as never);
const [logTop] = await db.all<{ top: number }>(sql`SELECT max(seq) AS top FROM jmap_changes WHERE mailbox_id = ${imapMailbox}`);
const loggedGuard = { mailboxId: imapMailbox, jmapSeq: Number(logTop.top) };
const writtenFirst = await db.update(messages).set({ starred: true }).where(and(eq(messages.id, logged), unchangedSinceLogged(loggedGuard, logged))).returning({ id: messages.id });
const writtenAgain = await db.update(messages).set({ starred: false }).where(and(eq(messages.id, logged), unchangedSinceLogged(loggedGuard, logged))).returning({ id: messages.id });
const [loggedRow] = await db.select({ starred: messages.starred }).from(messages).where(eq(messages.id, logged));
check("imap conditional update on the change log writes when nothing is newer and skips once something is", writtenFirst.length === 1 && writtenAgain.length === 0 && loggedRow.starred === true);
await db.delete(messages).where(eq(messages.id, logged));
await syncMailbox(env, imapMailbox);

// IMAP CONDSTORE and QRESYNC: the mod-sequence reads, the expunge log prune (state lock, floor update and delete in one batch, old rows read through the age index) and the vanished-UID answer on both sides of the floor.
const inboxView = await FolderView.open(env, imapMailbox, "inbox");
const inboxChanged = await changedSince(env, imapMailbox, "inbox", 0);
const inboxModseqs = await modseqsOf(env, imapMailbox, "inbox", [...inboxChanged]);
check("imap mod-sequence reads (by UID list, maximum in SQL, changed since) agree", inboxChanged.size >= 1 && inboxModseqs.size === inboxChanged.size && (await maxModseqOf(env, imapMailbox, "inbox", [...inboxChanged])) === Math.max(...inboxModseqs.values()));
const [loggedExpunges] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_expunged WHERE mailbox_id = ${imapMailbox} AND folder_key = 'inbox'`);
const vanishedFromLog = await vanishedSince(env, inboxView, 0, null);
await db.run(sql`UPDATE imap_expunged SET created_at = 1 WHERE mailbox_id = ${imapMailbox}`);
const pruned = await pruneImapExpunged(env, new Date());
const [floorRow] = await db.all<{ expunged_floor: number }>(sql`SELECT expunged_floor FROM imap_folder_state WHERE id = ${`${imapMailbox}:inbox`}`);
const [logLeft] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM imap_expunged WHERE mailbox_id = ${imapMailbox}`);
check("imap prune drops the old expunge rows and records the floor", pruned >= Number(loggedExpunges.n) && Number(logLeft.n) === 0 && Number(floorRow.expunged_floor) > 0);
const vanishedFromUids = await vanishedSince(env, inboxView, 0, null);
check("imap vanished UIDs are the same from the log and from the UIDs that exist", vanishedFromLog.length > 0 && JSON.stringify(vanishedFromLog) === JSON.stringify(vanishedFromUids));

await db.run(sql`INSERT INTO imap_message_flags (message_id, answered, keywords) VALUES (${`imsg_${stamp}`}, ${true}, ${'["$label1"]'})`);
const backup = await exportDatabaseRecords(d1);
const exported = JSON.parse(new TextDecoder().decode(backup)) as { tables: Record<string, Array<Record<string, unknown>>> };
check("backup leaves out the serial id of dmarc_daily_stats", exported.tables.dmarc_daily_stats.length >= 2 && exported.tables.dmarc_daily_stats.every((row) => !("id" in row)));
check("backup exports portable values", exported.tables.users.every((row) => typeof row.disabled === "number") && exported.tables.messages.length >= 1);
await restoreDatabaseRecords(d1, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength) as ArrayBuffer);
const [afterRestore] = await db.select({ subject: messages.subject, starred: messages.starred, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, `imsg_${stamp}`));
check("backup restores", afterRestore?.subject === "Quarterly Report" && afterRestore.starred === false && afterRestore.createdAt instanceof Date);
const [imapLeft] = await db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM imap_uids) + (SELECT count(*) FROM imap_expunged) + (SELECT count(*) FROM imap_mailbox_state) + (SELECT count(*) FROM imap_folder_state WHERE uid_next <> 1 OR highest_modseq > 1) AS n`);
check("restore clears the derived IMAP state tables", Number(imapLeft.n) === 0);
const [validity] = await db.all<{ uidvalidity: number; highest_modseq: number }>(sql`SELECT uidvalidity, highest_modseq FROM imap_folder_state WHERE id = ${`${imapMailbox}:archive`}`);
check("restore keeps UIDVALIDITY above its old value", Number(validity?.uidvalidity) > 1_000_000_000);
check("restore re-seeds a folder with HIGHESTMODSEQ 1, never 0", Number(validity?.highest_modseq) === 1);
const [flags] = await db.all<{ answered: unknown; keywords: string }>(sql`SELECT answered, keywords FROM imap_message_flags WHERE message_id = ${`imsg_${stamp}`}`);
check("imap_message_flags are backed up and restored", Boolean(flags) && Number(flags.answered) === 1 || flags?.answered === true);

const davAfterRestore = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM dav_cards WHERE id = ${`card_${stamp}`}`);
check("backup restores dav cards and collections", Number(davAfterRestore[0].n) === 1 && exported.tables.dav_cards.length === 1 && exported.tables.dav_collections.length === 1 && !("dav_changes" in exported.tables));
await db.delete(calendarEvents).where(eq(calendarEvents.id, davEventId));
check("dav trigger logs a deleted event", (await davLog(`cal:${userId}`, davEventId)).endsWith("destroyed"));
reportObjects.set("raw5", reportMime(`r5_${stamp}`));
await ingestReportMail(reportEnv, reportTarget, { rawR2Key: "raw5", authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
const afterRestoreStats = await getDmarcStats(reportEnv, reportTarget.domainId, { days: 7 });
check("dmarc ingest keeps working after a restore (sequence not behind the rows)", afterRestoreStats.series.reduce((sum, day) => sum + day.pass, 0) === 80);

const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, "default"));
check("seed rows present", settings?.appName === "Mailflare");

await db.delete(users).where(eq(users.id, userId));
const remaining = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE user_id = ${userId}`);
check("cascade delete", Number(remaining[0].n) === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
