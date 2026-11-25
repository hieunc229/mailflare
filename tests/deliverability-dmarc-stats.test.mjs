import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dmarc-stats-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { stats: join(root, "src/lib/deliverability/dmarc-stats.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { getDmarcStats, normalizeDays } = await load("stats");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const seconds = (date) => Math.floor(date.getTime() / 1000);
const NOW = new Date("2025-11-19T12:00:00Z");

async function fixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(NOW);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	for (const id of ["d1", "d2"]) database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES (?, 'u1', ?, 'z', ?)").run(id, `${id}.example.com`, now);
	const insert = database.db.prepare("INSERT INTO dmarc_daily_stats (domain_id, day, row_key, source_ip, source_host, reporter_org, header_from, disposition, dkim_aligned, spf_aligned, message_count) VALUES (?, ?, ?, ?, ?, ?, 'd1.example.com', ?, ?, ?, ?)");
	let n = 0;
	const stat = ({ domain = "d1", day, ip = "192.0.2.1", host = null, org = "google.com", disposition = "none", dkim = 1, spf = 1, count }) => insert.run(domain, day, `k${n++}`, ip, host, org, disposition, dkim, spf, count);
	return { env: { DB: database }, stat, raw: database.db };
}

test("normalizeDays accepts only 7, 30 and 90", () => {
	assert.deepEqual(["7", "30", "90", "31", "", null, "abc", "-7", 90].map(normalizeDays), [7, 30, 90, 30, 30, 30, 30, 30, 90]);
});

test("the daily series classifies messages as pass, fail-but-delivered, quarantined or rejected and fills empty days", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", count: 10 });
	f.stat({ day: "2025-11-18", dkim: 0, spf: 1, count: 4 });
	f.stat({ day: "2025-11-18", dkim: 0, spf: 0, disposition: "none", count: 3 });
	f.stat({ day: "2025-11-18", dkim: 0, spf: 0, disposition: "quarantine", count: 2 });
	f.stat({ day: "2025-11-18", dkim: 0, spf: 0, disposition: "reject", count: 1 });
	f.stat({ day: "2025-11-16", count: 5 });
	f.stat({ domain: "d2", day: "2025-11-18", count: 999 });
	const result = await getDmarcStats(f.env, "d1", { days: 7, now: NOW });
	assert.equal(result.series.length, 7);
	assert.equal(result.series[0].day, "2025-11-13");
	assert.equal(result.series.at(-1).day, "2025-11-19");
	assert.deepEqual(result.series.find((row) => row.day === "2025-11-18"), { day: "2025-11-18", pass: 14, failDelivered: 3, quarantined: 2, rejected: 1 });
	assert.deepEqual(result.series.find((row) => row.day === "2025-11-17"), { day: "2025-11-17", pass: 0, failDelivered: 0, quarantined: 0, rejected: 0 });
	assert.equal(result.series.find((row) => row.day === "2025-11-16").pass, 5);
});

test("days outside the range are left out", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-01", count: 8 });
	f.stat({ day: "2025-11-18", count: 1 });
	const week = await getDmarcStats(f.env, "d1", { days: 7, now: NOW });
	assert.equal(week.sources.reduce((sum, row) => sum + row.messages, 0), 1);
	const month = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.equal(month.sources.reduce((sum, row) => sum + row.messages, 0), 9);
});

test("unverified reports are counted for the page but contribute no rows", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", count: 10 });
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES (?, ?, ?, ?, ?)");
	insert.run("u1", "d1", "ku1", "unverified", seconds(NOW) - 60);
	insert.run("u2", "d1", "ku2", "unverified", seconds(NOW) - 120);
	insert.run("u3", "d1", "ku3", "unverified", seconds(NOW) - 40 * 86400);
	insert.run("u4", "d2", "ku4", "unverified", seconds(NOW) - 60);
	insert.run("o1", "d1", "ko1", "over_budget", seconds(NOW) - 60);
	const result = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.equal(result.unverifiedReports, 2);
	assert.deepEqual(result.sources.map((row) => row.sourceIp), ["192.0.2.1"]);
});

test("by source: totals, pass, dkim and spf alignment, worst disposition, reporters and host", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-17", ip: "192.0.2.7", host: "mail.example.net", count: 6 });
	f.stat({ day: "2025-11-18", ip: "192.0.2.7", org: "yahoo.com", dkim: 0, spf: 1, count: 3 });
	f.stat({ day: "2025-11-18", ip: "192.0.2.7", org: "yahoo.com", dkim: 0, spf: 0, disposition: "quarantine", count: 1 });
	const [source] = (await getDmarcStats(f.env, "d1", { days: 30, now: NOW })).sources;
	assert.deepEqual(source, { sourceIp: "192.0.2.7", sourceHost: "mail.example.net", messages: 10, passMessages: 9, dkimMessages: 6, spfMessages: 9, worstDisposition: "quarantine", reporters: 2 });
});

test("by reporter: messages, pass and the number of reports", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", org: "google.com", count: 10 });
	f.stat({ day: "2025-11-18", org: "google.com", ip: "192.0.2.2", dkim: 0, spf: 0, disposition: "reject", count: 10 });
	f.stat({ day: "2025-11-18", org: "yahoo.com", count: 1 });
	// The org_name a report claims is not what is counted: reports are grouped by the verified sender.
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, reporter_org, sender_domain, date_begin, verified_reporter, status, received_at) VALUES (?, 'd1', ?, ?, ?, ?, ?, ?, ?)");
	const begin = seconds(new Date("2025-11-18T00:00:00Z"));
	insert.run("r1", "k1", "Google", "google.com", begin, 1, "ok", begin);
	insert.run("r2", "k2", "Google LLC", "google.com", begin - 86400, 1, "ok", begin);
	insert.run("r3", "k3", "google.com", "evil.example", begin, 0, "unverified", begin);
	insert.run("r4", "k4", "google.com", "google.com", begin, 1, "failed", begin);
	insert.run("r5", "k5", "Yahoo", "yahoo.com", begin, 1, "ok", begin);
	const { reporters } = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.deepEqual(reporters, [{ reporterOrg: "google.com", reports: 2, messages: 20, passMessages: 10 }, { reporterOrg: "yahoo.com", reports: 1, messages: 1, passMessages: 1 }]);
});

test("recent reports list the last ten with their status", async (t) => {
	const f = await fixture(t);
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, reporter_org, status, error, verified_reporter, message_count, received_at) VALUES (?, ?, ?, 'google.com', ?, ?, 1, 5, ?)");
	for (let i = 0; i < 12; i += 1) insert.run(`r${i}`, "d1", `k${i}`, i === 11 ? "rejected" : "ok", i === 11 ? "Domain mismatch" : null, seconds(NOW) - (12 - i) * 60);
	insert.run("other", "d2", "kx", "ok", null, seconds(NOW));
	const { recentReports } = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.equal(recentReports.length, 10);
	assert.deepEqual([recentReports[0].status, recentReports[0].error], ["rejected", "Domain mismatch"]);
	assert.equal(recentReports[0].verifiedReporter, true);
});

test("the per-reporter tables are limited to 100 rows", async (t) => {
	const f = await fixture(t);
	for (let index = 0; index < 120; index += 1) f.stat({ day: "2025-11-18", org: `r${index}.example`, count: 1 + index });
	const result = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.equal(result.reporters.length, 100);
	assert.equal(result.reporters[0].reporterOrg, "r119.example");
});

test("TLS-RPT reports are not DMARC reports: not counted as unverified, as reporter reports or listed as recent", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", org: "google.com", count: 10 });
	const begin = seconds(new Date("2025-11-18T00:00:00Z"));
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, kind, report_key, reporter_org, sender_domain, date_begin, verified_reporter, status, received_at) VALUES (?, 'd1', ?, ?, 'google.com', 'google.com', ?, ?, ?, ?)");
	insert.run("t1", "tlsrpt", "kt1", begin, 1, "ok", begin);
	insert.run("t2", "tlsrpt", "kt2", begin, 0, "unverified", seconds(NOW) - 60);
	insert.run("m1", "dmarc", "km1", begin, 1, "ok", begin);
	const result = await getDmarcStats(f.env, "d1", { days: 30, now: NOW });
	assert.equal(result.unverifiedReports, 0);
	assert.deepEqual(result.reporters.map((row) => [row.reporterOrg, row.reports]), [["google.com", 1]]);
	assert.deepEqual(result.recentReports.map((row) => row.id), ["m1"]);
});
