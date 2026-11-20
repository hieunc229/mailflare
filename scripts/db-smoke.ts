/**
 * Exercises the database layer against any DATABASE_URL: migrations, the query shapes the app relies on
 * (insert/select/update, returning, onConflict*, raw sql, batch), the triggers and search.
 * Run with `npm run db:smoke -- <DATABASE_URL> [driver]`; PGlite needs no server (`pglite://memory`).
 */
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "@/db";
import { users, domains, mailboxes, messages, folders, jmapChanges, appSettings, webhooks, spamTokenStats, spamReputation, emailSuppressions, domainDeliverability } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations, getMigrationStatus } from "@/lib/migrations/service";
import { buildSearchConditions } from "@/lib/search/conditions";
import { createBookedCalendarEvents } from "@/lib/booking/create";
import { exportDatabaseRecords, restoreDatabaseRecords } from "@/lib/backups/export";
import { getSearchIndexStatus } from "@/lib/search/index-admin";
import { recordReputationObservation } from "@/lib/spam/repository";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { recordSuppression } from "@/lib/deliverability/suppression";
import { ingestReportMail } from "@/lib/deliverability/ingest";
import { runDeliverabilityDaily } from "@/lib/deliverability/daily";
import { getDmarcStats } from "@/lib/deliverability/dmarc-stats";
import { gzipSync } from "node:zlib";

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

await db.insert(domainDeliverability).values({ domainId: reportTarget.domainId, reportsEnabled: true, reportsEnabledAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
await runDeliverabilityDaily(reportEnv, new Date(), { sendMail: async () => true });
await runDeliverabilityDaily(reportEnv, new Date(Date.now() + 200 * 86_400_000), { sendMail: async () => true });
const leftover = await db.all<{ n: number }>(sql`SELECT (SELECT count(*) FROM dmarc_daily_stats WHERE domain_id = ${reportTarget.domainId}) + (SELECT count(*) FROM deliverability_reports WHERE domain_id = ${reportTarget.domainId}) AS n`);
check("deliverability daily job purges data past retention", Number(leftover[0].n) === 0);

try {
	await db.insert(users).values({ id: `usr2_${stamp}`, email: `a${stamp}@example.com`, passwordHash: "x", name: "B" });
	check("unique violation throws", false);
} catch (error) {
	check("unique violation is recognised", isUniqueConstraintError(error));
}

const searchStatus = await getSearchIndexStatus(env);
check("search index status", searchStatus.messages === searchStatus.indexed && searchStatus.messages >= 1);

// An aggregate row that exists when the backup is taken: dmarc_daily_stats has a serial id that must not be backed up.
reportObjects.set("raw4", reportMime(`r4_${stamp}`));
await ingestReportMail(reportEnv, reportTarget, { rawR2Key: "raw4", authenticated: true, from: "r@google.com" }, { lookupPtr: async () => null });
const backup = await exportDatabaseRecords(d1);
const exported = JSON.parse(new TextDecoder().decode(backup)) as { tables: Record<string, Array<Record<string, unknown>>> };
check("backup leaves out the serial id of dmarc_daily_stats", exported.tables.dmarc_daily_stats.length >= 2 && exported.tables.dmarc_daily_stats.every((row) => !("id" in row)));
check("backup exports portable values", exported.tables.users.every((row) => typeof row.disabled === "number") && exported.tables.messages.length >= 1);
await restoreDatabaseRecords(d1, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength) as ArrayBuffer);
const [afterRestore] = await db.select({ subject: messages.subject, starred: messages.starred, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, `msg_${stamp}`));
check("backup restores", afterRestore?.subject === "Quarterly Report" && afterRestore.starred === false && afterRestore.createdAt instanceof Date);

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
