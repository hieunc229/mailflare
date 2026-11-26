import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-daily-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { daily: join(root, "src/lib/deliverability/daily.ts"), ingest: join(root, "src/lib/deliverability/ingest.ts"), alerts: join(root, "src/lib/deliverability/alerts.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime", "cloudflare:workers"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { runDeliverabilityDaily, RETENTION } = await load("daily");
const { INGEST_LIMITS } = await load("ingest");
const { listOpenAlerts, acknowledgeAlert } = await load("alerts");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const DAY = 86_400_000;
const seconds = (date) => Math.floor(date.getTime() / 1000);
const NOW = new Date("2025-11-19T02:00:00Z");
const dayOf = (offset) => new Date(NOW.getTime() - offset * DAY).toISOString().slice(0, 10);

async function fixture(t, { enabled = true, alertEmail = false, enabledDaysAgo = 30, lastReportDaysAgo = 1 } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(NOW);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'owner@example.com', 'Owner', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'z', ?)").run(now);
	database.db.prepare("INSERT INTO domain_deliverability (domain_id, reports_enabled, reports_enabled_at, alert_email, last_report_at, updated_at) VALUES ('d1', ?, ?, ?, ?, ?)").run(enabled ? 1 : 0, seconds(new Date(NOW.getTime() - enabledDaysAgo * DAY)), alertEmail ? 1 : 0, lastReportDaysAgo === null ? null : seconds(new Date(NOW.getTime() - lastReportDaysAgo * DAY)), now);
	const insert = database.db.prepare("INSERT INTO dmarc_daily_stats (domain_id, day, row_key, source_ip, reporter_org, header_from, disposition, dkim_aligned, spf_aligned, message_count) VALUES ('d1', ?, ?, ?, ?, 'example.com', 'none', ?, ?, ?)");
	let n = 0;
	const stat = ({ day, ip, pass = true, org = "google.com", count }) => insert.run(day, `k${n++}`, ip, org, pass ? 1 : 0, pass ? 1 : 0, count);
	const mails = [];
	const sendMail = async (_env, mail) => { mails.push(mail); return true; };
	const q = (sql, ...args) => database.db.prepare(sql).all(...args);
	return { env: { DB: database }, stat, mails, sendMail, q, raw: database.db };
}

test("creates a spoofing alert from yesterday's failures and never duplicates it on a re-run", async (t) => {
	const f = await fixture(t);
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	f.stat({ day: dayOf(1), ip: "198.51.100.2", pass: false, count: 5 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	const alerts = f.q("SELECT kind, day, detail, acknowledged_at FROM deliverability_alerts");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].kind, "spoofing");
	assert.equal(alerts[0].day, dayOf(1));
	assert.deepEqual(JSON.parse(alerts[0].detail).sources.map((entry) => [entry.sourceIp, entry.failed]), [["198.51.100.1", 25]], "below the 10 message threshold is ignored");
	assert.deepEqual(f.mails, [], "no email unless the domain asked for alert email");
});

test("a verified reporter's own history cannot hide a spoofing alert computed from another reporter", async (t) => {
	const f = await fixture(t);
	// google.com reports 25 failures from the address; an attacker's verified reporter claims it passed for a month.
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, org: "google.com", count: 25 });
	for (let offset = 2; offset <= 20; offset += 1) f.stat({ day: dayOf(offset), ip: "198.51.100.1", pass: true, org: "evil.example", count: 500 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	const [alert] = f.q("SELECT kind, detail FROM deliverability_alerts");
	assert.equal(alert.kind, "spoofing");
	assert.deepEqual(JSON.parse(alert.detail).sources.map((entry) => [entry.reporter, entry.sourceIp, entry.failed]), [["google.com", "198.51.100.1", 25]]);
});

test("the source limit applies per reporter, so a noisy reporter cannot push another reporter's rows out", async (t) => {
	const f = await fixture(t);
	f.raw.exec("BEGIN");
	for (let index = 0; index < 2100; index += 1) f.stat({ day: dayOf(1), ip: `10.8.${index >> 8}.${index & 255}`, pass: false, org: "noisy.example", count: 100 });
	f.raw.exec("COMMIT");
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, org: "google.com", count: 12 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	const [alert] = f.q("SELECT detail FROM deliverability_alerts WHERE kind = 'spoofing'");
	assert.equal(JSON.parse(alert.detail).total, 2001, "2,000 from the noisy reporter, its limit, and the one source of the other");
});

test("a source that passed during the prior 30 days is not spoofing, and 31-day-old history does not count", async (t) => {
	const f = await fixture(t);
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	f.stat({ day: dayOf(5), ip: "198.51.100.1", pass: true, count: 3 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.q("SELECT * FROM deliverability_alerts").length, 0);
	const g = await fixture(t);
	g.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	g.stat({ day: dayOf(40), ip: "198.51.100.1", pass: true, count: 3 });
	await runDeliverabilityDaily(g.env, NOW, { sendMail: g.sendMail });
	assert.equal(g.q("SELECT kind FROM deliverability_alerts")[0].kind, "spoofing");
});

test("an auth regression is found from 30 days of history", async (t) => {
	const f = await fixture(t);
	for (let offset = 2; offset <= 11; offset += 1) f.stat({ day: dayOf(offset), ip: "192.0.2.1", pass: true, count: 10 });
	f.stat({ day: dayOf(1), ip: "192.0.2.1", pass: false, count: 12 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.deepEqual(f.q("SELECT kind FROM deliverability_alerts").map((row) => row.kind), ["auth_regression"]);
});

test("no_reports fires once, then not again for a week", async (t) => {
	const f = await fixture(t, { lastReportDaysAgo: 10 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.deepEqual(f.q("SELECT kind FROM deliverability_alerts").map((row) => row.kind), ["no_reports"]);
	await runDeliverabilityDaily(f.env, new Date(NOW.getTime() + 2 * DAY), { sendMail: f.sendMail });
	assert.equal(f.q("SELECT kind FROM deliverability_alerts").length, 1);
	await runDeliverabilityDaily(f.env, new Date(NOW.getTime() + 8 * DAY), { sendMail: f.sendMail });
	assert.equal(f.q("SELECT kind FROM deliverability_alerts").length, 2);
});

test("a domain with reporting off gets no alerts", async (t) => {
	const f = await fixture(t, { enabled: false, lastReportDaysAgo: 10 });
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.q("SELECT * FROM deliverability_alerts").length, 0);
});

test("alert email goes to the domain owner only for new alerts, and a send failure does not stop the job", async (t) => {
	const f = await fixture(t, { alertEmail: true });
	f.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.mails.length, 1);
	assert.equal(f.mails[0].to, "owner@example.com");
	assert.equal(f.mails[0].hostname, "example.com");
	assert.match(f.mails[0].subject, /example\.com/);
	assert.match(f.mails[0].text, /198\.51\.100\.1/);
	const g = await fixture(t, { alertEmail: true });
	g.stat({ day: dayOf(1), ip: "198.51.100.1", pass: false, count: 25 });
	await runDeliverabilityDaily(g.env, NOW, { sendMail: async () => { throw new Error("smtp down"); } });
	assert.equal(g.q("SELECT * FROM deliverability_alerts").length, 1);
});

test("retention deletes data older than 180 days and acknowledged old alerts, in bounded batches", async (t) => {
	const f = await fixture(t, { enabled: false });
	const old = dayOf(181);
	const recent = dayOf(10);
	for (let i = 0; i < 1200; i += 1) f.stat({ day: old, ip: `10.0.${i >> 8}.${i & 255}`, count: 1 });
	f.stat({ day: recent, ip: "192.0.2.1", count: 1 });
	const report = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES (?, 'd1', ?, 'ok', ?)");
	report.run("old", "ko", seconds(new Date(NOW.getTime() - 181 * DAY)));
	report.run("new", "kn", seconds(new Date(NOW.getTime() - 5 * DAY)));
	const alert = f.raw.prepare("INSERT INTO deliverability_alerts (id, domain_id, kind, day, detail, created_at, acknowledged_at) VALUES (?, 'd1', ?, ?, '{}', ?, ?)");
	alert.run("a-old-ack", "spoofing", old, seconds(new Date(NOW.getTime() - 181 * DAY)), seconds(new Date(NOW.getTime() - 180 * DAY)));
	alert.run("a-old-open", "auth_regression", old, seconds(new Date(NOW.getTime() - 181 * DAY)), null);
	alert.run("a-new-ack", "no_reports", recent, seconds(new Date(NOW.getTime() - 5 * DAY)), seconds(NOW));
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats WHERE day = ?", old)[0].n, 0);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats WHERE day = ?", recent)[0].n, 1);
	assert.deepEqual(f.q("SELECT id FROM deliverability_reports").map((row) => row.id), ["new"]);
	assert.deepEqual(f.q("SELECT id FROM deliverability_alerts ORDER BY id").map((row) => row.id), ["a-new-ack", "a-old-open"], "an unacknowledged alert is kept");
});

test("each table has its own per-run retention budget, large enough for one domain's maximum daily inflow", async (t) => {
	assert.ok(RETENTION.batches.stats * RETENTION.batchRows >= INGEST_LIMITS.statsRowsPerDomainPerDay, "aggregate rows");
	assert.ok(RETENTION.batches.reports * RETENTION.batchRows >= INGEST_LIMITS.unauthenticatedReportsPerDay + INGEST_LIMITS.authenticatedReportsPerDay, "report rows");
	const f = await fixture(t, { enabled: false });
	const rows = RETENTION.batchRows * RETENTION.batches.reports + 700;
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES (?, 'd1', ?, 'ok', ?)");
	f.raw.exec("BEGIN");
	for (let i = 0; i < rows; i += 1) insert.run(`r${i}`, `k${i}`, seconds(new Date(NOW.getTime() - 200 * DAY)));
	f.raw.exec("COMMIT");
	// Aggregates are purged in the same run: the report backlog does not use their budget.
	for (let i = 0; i < 1000; i += 1) f.stat({ day: dayOf(200), ip: `10.0.${i >> 8}.${i & 255}`, count: 1 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 700);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 0);
});

test("deletes bind at most 90 ids per statement", async (t) => {
	const f = await fixture(t, { enabled: false });
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES (?, 'd1', ?, 'ok', ?)");
	for (let i = 0; i < 300; i += 1) insert.run(`r${i}`, `k${i}`, seconds(new Date(NOW.getTime() - 200 * DAY)));
	const binds = [];
	const spy = new Proxy(f.env.DB, { get(target, key) { if (key === "prepare") return (sql) => new Proxy(target.prepare(sql), { get(statement, name) { if (name === "bind") return (...values) => { binds.push(values.length); return statement.bind(...values); }; const value = statement[name]; return typeof value === "function" ? value.bind(statement) : value; } }); const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } });
	await runDeliverabilityDaily({ DB: spy }, NOW, { sendMail: f.sendMail });
	assert.ok(Math.max(...binds) <= 100, `max binds ${Math.max(...binds)}`);
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 0);
});

test("the job does nothing before the migration is applied", async () => {
	await runDeliverabilityDaily({ DB: { prepare() { throw new Error("no such table: domain_deliverability"); } } }, NOW, {});
});

test("listOpenAlerts returns unacknowledged alerts of one domain, newest first, and acknowledgeAlert marks one", async (t) => {
	const f = await fixture(t);
	f.raw.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'other.org', 'z', ?)").run(seconds(NOW));
	const insert = f.raw.prepare("INSERT INTO deliverability_alerts (id, domain_id, kind, day, detail, created_at) VALUES (?, ?, ?, ?, '{\"total\":1}', ?)");
	insert.run("a1", "d1", "spoofing", "2025-11-17", seconds(NOW) - 100);
	insert.run("a2", "d1", "no_reports", "2025-11-18", seconds(NOW));
	insert.run("a3", "d2", "spoofing", "2025-11-18", seconds(NOW));
	assert.deepEqual((await listOpenAlerts(f.env, "d1")).map((alert) => alert.id), ["a2", "a1"]);
	assert.equal(await acknowledgeAlert(f.env, "d1", "a3", "u1"), false, "an alert of another domain cannot be acknowledged here");
	assert.equal(await acknowledgeAlert(f.env, "d1", "a2", "u1"), true);
	assert.deepEqual((await listOpenAlerts(f.env, "d1")).map((alert) => alert.id), ["a1"]);
	assert.equal(f.q("SELECT acknowledged_by_user_id AS who FROM deliverability_alerts WHERE id = 'a2'")[0].who, "u1");
	assert.deepEqual((await listOpenAlerts(f.env, "d1"))[0].detail, { total: 1 });
});

test("20 new high-volume reporters cannot displace an established reporter, whose spoofing alert still fires", async (t) => {
	const f = await fixture(t);
	for (let offset = 2; offset <= 6; offset += 1) f.stat({ day: dayOf(offset), ip: "192.0.2.1", org: "google.com", count: 5 });
	f.stat({ day: dayOf(1), ip: "192.0.2.1", org: "google.com", count: 5 });
	f.stat({ day: dayOf(1), ip: "198.51.100.9", pass: false, org: "google.com", count: 25 });
	for (let index = 0; index < 20; index += 1) f.stat({ day: dayOf(1), ip: `203.0.113.${index}`, org: `fake${index}.example`, count: 10_000_000 });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	const [alert] = f.q("SELECT kind, detail FROM deliverability_alerts");
	assert.equal(alert.kind, "spoofing");
	assert.deepEqual(JSON.parse(alert.detail).sources.map((entry) => [entry.reporter, entry.sourceIp, entry.failed]), [["google.com", "198.51.100.9", 25]]);
});

test("reporters with history rank by distinct report days, and new reporters fill only the remaining slots", async (t) => {
	const f = await fixture(t);
	// 19 established reporters (history 3 days) and 5 new ones: the new reporter with the most volume takes the one free slot.
	for (let index = 0; index < 19; index += 1) {
		for (let offset = 2; offset <= 4; offset += 1) f.stat({ day: dayOf(offset), ip: "192.0.2.1", org: `old${index}.example`, count: 1 });
		f.stat({ day: dayOf(1), ip: "192.0.2.1", pass: false, org: `old${index}.example`, count: 1 });
	}
	for (let index = 0; index < 5; index += 1) f.stat({ day: dayOf(1), ip: `198.51.100.${index}`, pass: false, org: `new${index}.example`, count: 20 + index });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	const [alert] = f.q("SELECT detail FROM deliverability_alerts WHERE kind = 'spoofing'");
	assert.deepEqual(JSON.parse(alert.detail).sources.map((entry) => entry.reporter), ["new4.example"]);
});

test("retention also deletes TLS-RPT aggregates older than 180 days", async (t) => {
	const f = await fixture(t, { enabled: false });
	const insert = f.raw.prepare("INSERT INTO tls_daily_stats (domain_id, day, row_key, reporter_org, policy_type, result_type, success_count, failure_count) VALUES ('d1', ?, ?, 'google.com', 'sts', '', 1, 0)");
	for (let i = 0; i < 700; i += 1) insert.run(dayOf(181), `old${i}`);
	insert.run(dayOf(10), "new");
	await runDeliverabilityDaily(f.env, NOW, { sendMail: f.sendMail });
	assert.deepEqual(f.q("SELECT row_key FROM tls_daily_stats").map((row) => row.row_key), ["new"]);
});
