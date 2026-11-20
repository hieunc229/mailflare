import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tlsrpt-ingest-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		ingest: join(root, "src/lib/deliverability/ingest.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { ingestReportMail } = await load("ingest");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const NOW = new Date("2025-11-19T12:00:00Z");
const tlsJson = readFileSync(join(root, "tests/fixtures/tlsrpt/google.json"), "utf8");
const dmarcXml = readFileSync(join(root, "tests/fixtures/dmarc/google.xml"), "utf8");
const withId = (id) => tlsJson.replace("2025-11-18T00:00:00Z_example.com", id);

function mime(attachment) {
	const boundary = "b0undary";
	return Buffer.from(`From: noreply-smtp-tls-reporting@google.com\r\nTo: mailflare-reports@example.com\r\nSubject: Report Domain: example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nTLS report\r\n--${boundary}\r\nContent-Type: ${attachment.type ?? "application/tlsrpt+gzip"}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${attachment.name ?? "report.json.gz"}"\r\n\r\n${Buffer.from(attachment.bytes).toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n--${boundary}--\r\n`);
}
const gz = (text) => mime({ bytes: gzipSync(text) });

async function fixture(t, { enabled = true } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(NOW);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'other.org', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO domain_deliverability (domain_id, reports_enabled, reports_enabled_at, updated_at) VALUES ('d1', ?, ?, ?)").run(enabled ? 1 : 0, now, now);
	const objects = new Map();
	const deleted = [];
	const bucket = {
		async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.size ?? bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } : null; },
		async delete(key) { deleted.push(key); objects.delete(key); },
	};
	const binds = [];
	const lookups = [];
	const batches = [];
	const spy = new Proxy(database, {
		get(target, key) {
			if (key === "prepare") return (sql) => new Proxy(target.prepare(sql), { get(statement, name) { if (name === "bind") return (...values) => { binds.push(values.length); return statement.bind(...values); }; const value = statement[name]; return typeof value === "function" ? value.bind(statement) : value; } });
			if (key === "batch") return (statements) => { batches.push(statements.length); return target.batch(statements); };
			const value = target[key];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const env = { DB: spy, BUCKET: bucket };
	const put = (key, raw) => objects.set(key, raw);
	const target = { domainId: "d1", hostname: "example.com" };
	const ingest = (key, raw, { authenticated = true, from = "noreply-smtp-tls-reporting@google.com", ...deps } = {}) => { put(key, raw); return ingestReportMail(env, target, { rawR2Key: key, authenticated, from }, { now: NOW, lookupPtr: async () => { lookups.push(1); return null; }, ...deps }); };
	const q = (sql, ...args) => database.db.prepare(sql).all(...args);
	/** Report rows already counted today, as if earlier mail had been ingested. */
	const seed = (count, { prefix, authenticated = 0, sender = null, verified = 0, statsRows = 0, status = "ok", ageSeconds = 60 } = {}) => {
		const insert = database.db.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, authenticated, sender_domain, verified_reporter, stats_rows, status, received_at) VALUES (?, 'd1', ?, ?, ?, ?, ?, ?, ?)");
		for (let index = 0; index < count; index += 1) insert.run(`${prefix}${index}`, `${prefix}k${index}`, authenticated, sender, verified, statsRows, status, seconds(NOW) - ageSeconds);
	};
	return { env, ingest, q, deleted, binds, batches, objects, put, seed, lookups, raw: database.db };
}


const stats = (f) => f.q("SELECT day, reporter_org, policy_type, mx_host, result_type, success_count, failure_count FROM tls_daily_stats ORDER BY policy_type, result_type");

test("ingests a gzip TLS-RPT report: header row, daily rows, raw mail removed, no reverse lookups", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(tlsJson));
	const [report] = f.q("SELECT * FROM deliverability_reports");
	assert.equal(report.kind, "tlsrpt");
	assert.equal(report.status, "ok");
	assert.equal(report.reporter_org, "Google Inc.");
	assert.equal(report.external_report_id, "2025-11-18T00:00:00Z_example.com");
	assert.equal(report.message_count, 130);
	assert.equal(report.verified_reporter, 1);
	assert.equal(report.sender_domain, "google.com");
	assert.equal(report.stats_rows, 5);
	assert.deepEqual(stats(f), [
		{ day: "2025-11-18", reporter_org: "google.com", policy_type: "no-policy-found", mx_host: null, result_type: "", success_count: 3, failure_count: 0 },
		{ day: "2025-11-18", reporter_org: "google.com", policy_type: "sts", mx_host: "mail.example.com", result_type: "", success_count: 120, failure_count: 0 },
		{ day: "2025-11-18", reporter_org: "google.com", policy_type: "sts", mx_host: "mail.example.com", result_type: "certificate-expired", success_count: 0, failure_count: 4 },
		{ day: "2025-11-18", reporter_org: "google.com", policy_type: "sts", mx_host: "mail.example.com", result_type: "starttls-not-supported", success_count: 0, failure_count: 2 },
		{ day: "2025-11-18", reporter_org: "google.com", policy_type: "sts", mx_host: "mail.example.com", result_type: "unspecified", success_count: 0, failure_count: 1 },
	]);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.equal(f.lookups.length, 0);
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, null, "a TLS report does not count as a DMARC report arriving");
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("plain JSON in the mail body or as an attachment is accepted", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ bytes: Buffer.from(tlsJson), type: "application/tlsrpt+json", name: "report.json" }));
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "ok");
});

test("the same report twice, or a queue redelivery, changes nothing; a different report adds its counts", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(tlsJson));
	const before = stats(f);
	await f.ingest("raw/2", gz(tlsJson));
	await f.ingest("raw/1", gz(tlsJson));
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 1);
	assert.deepEqual(stats(f), before);
	await f.ingest("raw/3", gz(withId("second")));
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 2);
	assert.equal(stats(f).find((row) => row.policy_type === "sts" && row.result_type === "").success_count, 240);
});

test("a TLS-RPT report and a DMARC report with the same id from the same reporter do not collide", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(tlsJson.replace("2025-11-18T00:00:00Z_example.com", "13993201926883216094")));
	await f.ingest("raw/2", mime({ bytes: gzipSync(dmarcXml), type: "application/gzip", name: "r.xml.gz" }), { from: "noreply-dmarc-support@google.com" });
	assert.deepEqual(f.q("SELECT kind, status FROM deliverability_reports ORDER BY kind").map((row) => [row.kind, row.status]), [["dmarc", "ok"], ["tlsrpt", "ok"]]);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 3);
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 5);
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, seconds(NOW), "the DMARC report counts");
});

test("only a verified reporter writes TLS stats: unauthenticated mail, another sender organisation or no From stay a row", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(withId("a")), { authenticated: false });
	await f.ingest("raw/2", gz(withId("b")), { from: "dmarc@evil.example" });
	await f.ingest("raw/3", gz(tlsJson.replace("smtp-tls-reporting@google.com", "x@evil.example").replace("2025-11-18T00:00:00Z_example.com", "c")));
	await f.ingest("raw/4", gz(withId("d")), { from: null });
	assert.deepEqual(f.q("SELECT status, verified_reporter, stats_rows FROM deliverability_reports").map((row) => [row.status, row.verified_reporter, row.stats_rows]), [["unverified", 0, 0], ["unverified", 0, 0], ["unverified", 0, 0], ["unverified", 0, 0]]);
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 0);
	await f.ingest("raw/5", gz(withId("e")));
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 5);
});

test("a forged report cannot take a verified report's key", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(tlsJson));
	const before = stats(f);
	await f.ingest("raw/2", gz(tlsJson), { authenticated: false });
	assert.deepEqual(f.q("SELECT status FROM deliverability_reports ORDER BY verified_reporter DESC").map((row) => row.status), ["ok", "unverified"]);
	assert.deepEqual(stats(f), before);
});

test("TLS rows share the DMARC aggregate budgets: 1,000 per reporter and 5,000 per domain per day", async (t) => {
	const f = await fixture(t);
	f.seed(1, { prefix: "g", authenticated: 1, sender: "google.com", verified: 1, statsRows: 997 });
	await f.ingest("raw/1", gz(tlsJson));
	assert.deepEqual(f.q("SELECT status, stats_rows, verified_reporter FROM deliverability_reports WHERE kind = 'tlsrpt'")[0], { status: "over_budget", stats_rows: 0, verified_reporter: 1 });
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 0);
});

test("the daily report caps count TLS-RPT mail too", async (t) => {
	const f = await fixture(t);
	f.seed(300, { prefix: "junk", status: "unverified" });
	await f.ingest("raw/1", gz(tlsJson), { authenticated: false });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 300);
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("reports about another domain, broken JSON, bombs and a missing attachment are rejected or failed, never thrown", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", gz(tlsJson.replaceAll('"policy-domain": "example.com"', '"policy-domain": "victim.org"')));
	await f.ingest("raw/2", gz("{ not json"));
	await f.ingest("raw/3", mime({ bytes: gzipSync(Buffer.from(`{"x":"${" ".repeat(9 * 1024 * 1024)}"}`)) }));
	await f.ingest("raw/4", gz(`{"organization-name":"g","policies":${"[".repeat(500)}${"]".repeat(500)}}`));
	assert.deepEqual(f.q("SELECT status FROM deliverability_reports ORDER BY received_at, id").map((row) => row.status).sort(), ["rejected", "rejected", "rejected", "rejected"]);
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 0);
	assert.deepEqual(f.deleted, ["raw/1", "raw/2", "raw/3", "raw/4"]);
});

test("a 500-row report writes in batches of at most 50 statements, each under 100 bound parameters", async (t) => {
	const f = await fixture(t);
	const text = JSON.stringify({ ...JSON.parse(tlsJson), policies: Array.from({ length: 500 }, (_, index) => ({ policy: { "policy-type": "sts", "policy-domain": "example.com", "mx-host": [`mx${index}.example.com`] }, summary: { "total-successful-session-count": 1, "total-failure-session-count": 0 } })) });
	await f.ingest("raw/1", gz(text));
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 500);
	assert.ok(f.batches.length >= 10 && f.batches.every((size) => size <= 50));
	assert.ok(Math.max(...f.binds) < 100);
});

test("when writing the rows fails the report is marked failed and a redelivery does not count twice", async (t) => {
	const f = await fixture(t);
	f.raw.exec("CREATE TRIGGER tls_fail BEFORE INSERT ON tls_daily_stats BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
	await f.ingest("raw/1", gz(tlsJson));
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "failed");
	f.raw.exec("DROP TRIGGER tls_fail");
	await f.ingest("raw/1", gz(tlsJson));
	assert.equal(f.q("SELECT count(*) AS n FROM tls_daily_stats")[0].n, 0);
});

test("before the MTA-STS migration (no kind column) a report is dropped with a warning instead of failing the queue", async (t) => {
	const f = await fixture(t);
	f.raw.exec("ALTER TABLE deliverability_reports DROP COLUMN kind");
	const warn = console.warn;
	const warnings = [];
	console.warn = (...args) => warnings.push(args.join(" "));
	t.after(() => { console.warn = warn; });
	await f.ingest("raw/1", gz(tlsJson));
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 0);
	assert.deepEqual(f.deleted, ["raw/1"]);
	assert.match(warnings.join("\n"), /migration/i);
});
