import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tls-stats-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { stats: join(root, "src/lib/deliverability/tls-stats.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { getTlsStats } = await load("stats");
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
	const insert = database.db.prepare("INSERT INTO tls_daily_stats (domain_id, day, row_key, reporter_org, policy_type, mx_host, result_type, success_count, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	let n = 0;
	const stat = ({ domain = "d1", day, org = "google.com", type = "sts", mx = "mx.d1.example.com", result = "", success = 0, failure = 0 }) => insert.run(domain, day, `k${n++}`, org, type, mx, result, success, failure);
	return { env: { DB: database }, stat, raw: database.db };
}

test("the daily series sums successes and failures and fills empty days; other domains and old days are left out", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", success: 100 });
	f.stat({ day: "2025-11-18", result: "certificate-expired", failure: 4 });
	f.stat({ day: "2025-11-16", success: 5 });
	f.stat({ domain: "d2", day: "2025-11-18", success: 999 });
	f.stat({ day: "2025-10-01", success: 7 });
	const result = await getTlsStats(f.env, "d1", { days: 7, now: NOW });
	assert.equal(result.series.length, 7);
	assert.deepEqual(result.series.find((row) => row.day === "2025-11-18"), { day: "2025-11-18", success: 100, failure: 4 });
	assert.deepEqual(result.series.find((row) => row.day === "2025-11-17"), { day: "2025-11-17", success: 0, failure: 0 });
	assert.equal(result.series.find((row) => row.day === "2025-11-16").success, 5);
	assert.equal((await getTlsStats(f.env, "d1", { days: 90, now: NOW })).series.reduce((sum, row) => sum + row.success, 0), 112);
});

test("failure types, reporters and policies are totalled, busiest first", async (t) => {
	const f = await fixture(t);
	f.stat({ day: "2025-11-18", success: 50 });
	f.stat({ day: "2025-11-18", result: "certificate-expired", failure: 4 });
	f.stat({ day: "2025-11-17", result: "certificate-expired", failure: 3 });
	f.stat({ day: "2025-11-18", result: "starttls-not-supported", failure: 9, org: "yahoo.com" });
	f.stat({ day: "2025-11-18", type: "no-policy-found", mx: null, success: 2 });
	const result = await getTlsStats(f.env, "d1", { days: 30, now: NOW });
	assert.deepEqual(result.failureTypes, [{ resultType: "starttls-not-supported", failure: 9 }, { resultType: "certificate-expired", failure: 7 }]);
	assert.deepEqual(result.reporters, [{ reporterOrg: "google.com", success: 52, failure: 7 }, { reporterOrg: "yahoo.com", success: 0, failure: 9 }]);
	assert.deepEqual(result.policies.find((row) => row.policyType === "sts"), { policyType: "sts", mxHost: "mx.d1.example.com", success: 50, failure: 16 });
	assert.deepEqual(result.policies.find((row) => row.policyType === "no-policy-found"), { policyType: "no-policy-found", mxHost: null, success: 2, failure: 0 });
});

test("recent reports and the unverified count only cover TLS-RPT reports", async (t) => {
	const f = await fixture(t);
	const insert = f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, kind, report_key, reporter_org, status, verified_reporter, message_count, received_at) VALUES (?, 'd1', ?, ?, 'google.com', ?, ?, 5, ?)");
	insert.run("t1", "tlsrpt", "k1", "ok", 1, seconds(NOW) - 60);
	insert.run("t2", "tlsrpt", "k2", "unverified", 0, seconds(NOW) - 120);
	insert.run("t3", "tlsrpt", "k3", "unverified", 0, seconds(NOW) - 40 * 86400);
	insert.run("m1", "dmarc", "k4", "unverified", 0, seconds(NOW) - 30);
	const result = await getTlsStats(f.env, "d1", { days: 30, now: NOW });
	assert.deepEqual(result.recentReports.map((row) => row.id), ["t1", "t2", "t3"]);
	assert.equal(result.unverifiedReports, 1);
});

test("the tables are limited to 100 rows", async (t) => {
	const f = await fixture(t);
	for (let index = 0; index < 120; index += 1) f.stat({ day: "2025-11-18", org: `r${index}.example`, mx: `m${index}.example`, result: `t${index}`, failure: 1 + index });
	const result = await getTlsStats(f.env, "d1", { days: 30, now: NOW });
	assert.deepEqual([result.reporters.length, result.policies.length, result.failureTypes.length], [100, 100, 100]);
	assert.equal(result.reporters[0].reporterOrg, "r119.example");
});
