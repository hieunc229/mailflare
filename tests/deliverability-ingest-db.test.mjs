import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-ingest-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		ingest: join(root, "src/lib/deliverability/ingest.ts"),
		parse: join(root, "src/lib/deliverability/report-parse.ts"),
		address: join(root, "src/lib/deliverability/report-address.ts"),
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
const { rawReportKey } = await load("parse");
const { matchReportAddress, isReportAddressReserved, REPORT_ADDRESS_LOCAL_PART } = await load("address");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const NOW = new Date("2025-11-19T12:00:00Z");
const google = readFileSync(join(root, "tests/fixtures/dmarc/google.xml"), "utf8");
const withId = (xml, id) => xml.replace("<report_id>13993201926883216094</report_id>", `<report_id>${id}</report_id>`);

function mime({ attachment, text = "DMARC aggregate report" }) {
	const boundary = "b0undary";
	const parts = [`--${boundary}\r\nContent-Type: text/plain\r\n\r\n${text}\r\n`];
	if (attachment) parts.push(`--${boundary}\r\nContent-Type: ${attachment.type ?? "application/gzip"}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${attachment.name ?? "report.xml.gz"}"\r\n\r\n${Buffer.from(attachment.bytes).toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`);
	return Buffer.from(`From: noreply-dmarc-support@google.com\r\nTo: mailflare-reports@example.com\r\nSubject: Report Domain: example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${parts.join("")}--${boundary}--\r\n`);
}
const gz = (xml) => ({ bytes: gzipSync(xml) });

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
	const ingest = (key, raw, { authenticated = true, from = "noreply-dmarc-support@google.com", ...deps } = {}) => { put(key, raw); return ingestReportMail(env, target, { rawR2Key: key, authenticated, from }, { now: NOW, lookupPtr: async () => null, ...deps }); };
	const q = (sql, ...args) => database.db.prepare(sql).all(...args);
	/** Report rows already counted today, as if earlier mail had been ingested. */
	const seed = (count, { prefix, authenticated = 0, sender = null, verified = 0, statsRows = 0, status = "ok", ageSeconds = 60 } = {}) => {
		const insert = database.db.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, authenticated, sender_domain, verified_reporter, stats_rows, status, received_at) VALUES (?, 'd1', ?, ?, ?, ?, ?, ?, ?)");
		for (let index = 0; index < count; index += 1) insert.run(`${prefix}${index}`, `${prefix}k${index}`, authenticated, sender, verified, statsRows, status, seconds(NOW) - ageSeconds);
	};
	return { env, ingest, q, deleted, binds, batches, objects, put, seed, raw: database.db };
}

test("ingests a gzip report: header row, daily aggregates, last report time, raw mail removed", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { lookupPtr: async (ip) => (ip === "203.0.113.7" ? "mail.example.net" : null) });
	const [report] = f.q("SELECT * FROM deliverability_reports");
	assert.equal(report.status, "ok");
	assert.equal(report.reporter_org, "google.com");
	assert.equal(report.external_report_id, "13993201926883216094");
	assert.equal(report.record_count, 3);
	assert.equal(report.message_count, 50);
	assert.equal(report.authenticated, 1);
	assert.equal(report.verified_reporter, 1);
	assert.equal(report.sender_domain, "google.com");
	assert.equal(report.stats_rows, 3);
	assert.equal(report.policy_p, "none");
	assert.deepEqual(f.q("SELECT DISTINCT reporter_org FROM dmarc_daily_stats").map((row) => row.reporter_org), ["google.com"], "rows carry the verified reporter, not the org_name the XML claims");
	const stats = f.q("SELECT day, source_ip, source_host, disposition, dkim_aligned, spf_aligned, message_count FROM dmarc_daily_stats ORDER BY message_count DESC");
	assert.deepEqual(stats.map((row) => [row.day, row.source_ip, row.source_host, row.disposition, row.message_count]), [
		["2025-11-18", "203.0.113.7", "mail.example.net", "none", 42],
		["2025-11-18", "198.51.100.23", null, "reject", 5],
		["2025-11-18", "2001:db8::25", null, "quarantine", 3],
	]);
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, seconds(NOW));
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("the same report twice, or a queue redelivery, changes nothing", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	const before = f.q("SELECT * FROM dmarc_daily_stats ORDER BY id");
	await f.ingest("raw/2", mime({ attachment: gz(google) }));
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 1);
	assert.deepEqual(f.q("SELECT * FROM dmarc_daily_stats ORDER BY id"), before);
});

test("two different reports for the same day add their counts", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	await f.ingest("raw/2", mime({ attachment: gz(withId(google, "second")) }));
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 2);
	const rows = f.q("SELECT source_ip, message_count FROM dmarc_daily_stats ORDER BY message_count DESC");
	assert.deepEqual(rows.map((row) => row.message_count), [84, 10, 6]);
});

test("an unauthenticated report is recorded as unverified and writes no aggregates", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { authenticated: true });
	await f.ingest("raw/2", mime({ attachment: gz(withId(google, "forged")) }), { authenticated: false });
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 3);
	assert.equal(f.q("SELECT sum(message_count) AS total FROM dmarc_daily_stats")[0].total, 50);
	const forged = f.q("SELECT status, verified_reporter, stats_rows, authenticated, message_count FROM deliverability_reports WHERE external_report_id = 'forged'")[0];
	assert.deepEqual(forged, { status: "unverified", verified_reporter: 0, stats_rows: 0, authenticated: 0, message_count: 50 });
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, seconds(NOW), "only the verified one counts as a report received");
});

test("an unauthenticated report alone does not set last_report_at", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { authenticated: false });
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, null);
	assert.equal(f.q("SELECT authenticated FROM deliverability_reports")[0].authenticated, 0);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
});

test("a report that passed DMARC but names another organisation as its reporter is unverified", async (t) => {
	const f = await fixture(t);
	// The attacker owns evil.example (so the mail passes DMARC) but the XML claims to come from google.com.
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { authenticated: true, from: "dmarc@evil.example" });
	assert.deepEqual(f.q("SELECT status, verified_reporter, sender_domain, stats_rows FROM deliverability_reports")[0], { status: "unverified", verified_reporter: 0, sender_domain: "evil.example", stats_rows: 0 });
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, null);
	// The reverse: google really sent it, but the XML names a contact in another organisation.
	await f.ingest("raw/2", mime({ attachment: gz(withId(google.replace("noreply-dmarc-support@google.com", "x@evil.example"), "r2")) }), { authenticated: true });
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = 'r2'")[0].status, "unverified");
	// No usable From header: nothing to verify.
	await f.ingest("raw/3", mime({ attachment: gz(withId(google, "r3")) }), { authenticated: true, from: null });
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = 'r3'")[0].status, "unverified");
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
});

test("an unverified report cannot claim the key of a verified one, and a duplicate unverified report is still one row", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	const before = f.q("SELECT * FROM dmarc_daily_stats ORDER BY id");
	await f.ingest("raw/2", mime({ attachment: gz(google) }), { authenticated: false });
	await f.ingest("raw/3", mime({ attachment: gz(google) }), { authenticated: false });
	assert.deepEqual(f.q("SELECT status, verified_reporter FROM deliverability_reports ORDER BY verified_reporter DESC").map((row) => [row.status, row.verified_reporter]), [["ok", 1], ["unverified", 0]]);
	assert.deepEqual(f.q("SELECT * FROM dmarc_daily_stats ORDER BY id"), before);
});

test("300 forged unauthenticated reports write no aggregates and cannot stop a verified report", async (t) => {
	const f = await fixture(t);
	for (let index = 0; index < 300; index += 1) await f.ingest(`raw/f${index}`, mime({ attachment: gz(withId(google, `forged-${index}`)) }), { authenticated: false });
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports WHERE status = 'unverified'")[0].n, 300);
	await f.ingest("raw/301", mime({ attachment: gz(withId(google, "forged-301")) }), { authenticated: false });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 300, "the 301st junk report is dropped");
	assert.deepEqual(f.deleted.at(-1), "raw/301");
	await f.ingest("raw/real", mime({ attachment: gz(google) }), { authenticated: true });
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = '13993201926883216094'")[0].status, "ok");
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 3);
});

test("a sender that passes DMARC is capped per organisation, and cannot use up another's allowance", async (t) => {
	const f = await fixture(t);
	f.seed(300, { prefix: "evil", authenticated: 1, sender: "evil.example", status: "unverified" });
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { from: "dmarc@evil.example" });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 300, "dropped");
	await f.ingest("raw/2", mime({ attachment: gz(google) }));
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = '13993201926883216094'")[0].status, "ok");
});

test("verified reports are limited to 1,000 aggregate rows per reporter and 5,000 per domain per day; over budget is recorded without rows", async (t) => {
	const f = await fixture(t);
	f.seed(1, { prefix: "g", authenticated: 1, sender: "google.com", verified: 1, statsRows: 998 });
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	assert.deepEqual(f.q("SELECT status, stats_rows, verified_reporter FROM deliverability_reports WHERE external_report_id = '13993201926883216094'")[0], { status: "over_budget", stats_rows: 0, verified_reporter: 1 });
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.equal(f.q("SELECT last_report_at FROM domain_deliverability")[0].last_report_at, seconds(NOW), "a verified report did arrive");
	// Another verified reporter still has its own allowance ...
	const other = google.replace("noreply-dmarc-support@google.com", "dmarc@yahoo.com").replace("<org_name>google.com</org_name>", "<org_name>Yahoo</org_name>");
	await f.ingest("raw/2", mime({ attachment: gz(withId(other, "y1")) }), { from: "dmarc@yahoo.com" });
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = 'y1'")[0].status, "ok");
	// ... until the domain total is used up.
	f.seed(1, { prefix: "all", authenticated: 1, sender: "bing.com", verified: 1, statsRows: 4_990 });
	await f.ingest("raw/3", mime({ attachment: gz(withId(other, "y2")) }), { from: "dmarc@yahoo.com" });
	assert.equal(f.q("SELECT status FROM deliverability_reports WHERE external_report_id = 'y2'")[0].status, "over_budget");
});

test("the report row is committed as processing before the mail is parsed", async (t) => {
	const f = await fixture(t);
	let seen = null;
	f.put("raw/1", mime({ attachment: gz(google) }));
	const get = f.env.BUCKET.get;
	f.env.BUCKET.get = async (key) => { const object = await get(key); return { size: object.size, arrayBuffer: async () => { seen = f.q("SELECT status, authenticated FROM deliverability_reports"); return object.arrayBuffer(); } }; };
	await ingestReportMail(f.env, { domainId: "d1", hostname: "example.com" }, { rawR2Key: "raw/1", authenticated: true, from: "noreply-dmarc-support@google.com" }, { now: NOW, lookupPtr: async () => null });
	assert.deepEqual(seen, [{ status: "processing", authenticated: 1 }]);
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 1, "the placeholder became the report");
});

test("a report left in processing by a killed run is failed on redelivery, never counted twice", async (t) => {
	const f = await fixture(t);
	const stale = await rawReportKey("raw/1");
	f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES ('stale', 'd1', ?, 'processing', ?)").run(stale, seconds(NOW) - 600);
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	assert.deepEqual(f.q("SELECT id, status FROM deliverability_reports").map((row) => [row.id, row.status]), [["stale", "failed"]]);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("reports for a domain this install does not own are rejected and leave no aggregates", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google.replace("<domain>example.com</domain>\n    <adkim>", "<domain>victim.org</domain>\n    <adkim>")) }));
	const [report] = f.q("SELECT status, error FROM deliverability_reports");
	assert.equal(report.status, "rejected");
	assert.match(report.error, /domain mismatch/i);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("a decompression bomb is recorded as rejected, never thrown, and the raw mail is removed", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: { bytes: gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x20)) } }));
	const [report] = f.q("SELECT status, error FROM deliverability_reports");
	assert.equal(report.status, "rejected");
	assert.ok(report.error.length <= 300);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	assert.deepEqual(f.deleted, ["raw/1"]);
});

test("mail without a report attachment is rejected", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ text: "hello, nothing attached" }));
	const [report] = f.q("SELECT status, error FROM deliverability_reports");
	assert.equal(report.status, "rejected");
	assert.match(report.error, /no report attachment/i);
});

test("a report in the plain text body is accepted", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ text: google }));
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "ok");
});

test("a mail over the raw size cap is rejected without being read", async (t) => {
	const f = await fixture(t);
	let read = false;
	f.env.BUCKET.get = async () => ({ size: 5 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } });
	await ingestReportMail(f.env, { domainId: "d1", hostname: "example.com" }, { rawR2Key: "raw/big", authenticated: true, from: "a@google.com" }, { now: NOW, lookupPtr: async () => null });
	assert.equal(read, false);
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "rejected");
});

test("a missing raw object is skipped without throwing", async (t) => {
	const f = await fixture(t);
	await ingestReportMail(f.env, { domainId: "d1", hostname: "example.com" }, { rawR2Key: "raw/none", authenticated: true, from: "a@google.com" }, { now: NOW });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 0);
});

test("the unauthenticated daily cap drops later mail without writing, and yesterday's mail does not count", async (t) => {
	const f = await fixture(t);
	f.seed(300, { prefix: "r", status: "unverified" });
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { authenticated: false });
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports")[0].n, 300);
	assert.deepEqual(f.deleted, ["raw/1"]);
	f.raw.prepare("UPDATE deliverability_reports SET received_at = ?").run(seconds(NOW) - 2 * 86400);
	await f.ingest("raw/2", mime({ attachment: gz(google) }));
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 3);
});

test("only the 5 highest-volume sources are resolved, and a slow resolver cannot stall ingest", async (t) => {
	const f = await fixture(t);
	const record = (index) => `<record><row><source_ip>10.9.${index >> 8}.${index & 255}</source_ip><count>${100 - index}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const xml = google.replace(/<record>[\s\S]*<\/record>/, Array.from({ length: 40 }, (_, index) => record(index)).join(""));
	const asked = [];
	const started = performance.now();
	await f.ingest("raw/1", mime({ attachment: gz(xml) }), { ptrBudgetMs: 50, lookupPtr: (ip) => { asked.push(ip); return new Promise(() => {}); } });
	assert.equal(asked.length, 5);
	assert.deepEqual(asked.slice(0, 2), ["10.9.0.0", "10.9.0.1"]);
	assert.ok(performance.now() - started < 1500);
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 40);
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "ok");
});

test("reverse lookups share a per-batch budget across reports", async (t) => {
	const f = await fixture(t);
	const asked = [];
	const budget = { ptrLookups: 7 };
	const lookupPtr = async (ip) => { asked.push(ip); return null; };
	for (const id of ["a", "b", "c"]) await f.ingest(`raw/${id}`, mime({ attachment: gz(withId(google, id)) }), { lookupPtr, batchBudget: budget });
	assert.equal(asked.length, 7, "3 + 3 sources in the first two reports, 1 left for the third");
	assert.equal(budget.ptrLookups, 0);
	assert.equal(f.q("SELECT count(*) AS n FROM deliverability_reports WHERE status = 'ok'")[0].n, 3, "a spent budget only skips names");
});

test("a resolver result is sanitised and a failing resolver stores NULL", async (t) => {
	const f = await fixture(t);
	await f.ingest("raw/1", mime({ attachment: gz(google) }), { lookupPtr: async (ip) => { if (ip === "203.0.113.7") return "<script>x</script>.example.net."; throw new Error("servfail"); } });
	const hosts = f.q("SELECT source_ip, source_host FROM dmarc_daily_stats ORDER BY message_count DESC").map((row) => row.source_host);
	assert.deepEqual(hosts, [null, null, null]);
	const g = await fixture(t);
	await g.ingest("raw/1", mime({ attachment: gz(google) }), { lookupPtr: async () => "Mail.Example.NET." });
	assert.deepEqual(g.q("SELECT DISTINCT source_host FROM dmarc_daily_stats").map((row) => row.source_host), ["mail.example.net"]);
});

test("a 500-row report writes in batches of at most 50 statements, each under 100 bound parameters", async (t) => {
	const f = await fixture(t);
	const record = (index) => `<record><row><source_ip>10.7.${index >> 8}.${index & 255}</source_ip><count>2</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const xml = google.replace(/<record>[\s\S]*<\/record>/, Array.from({ length: 900 }, (_, index) => record(index)).join(""));
	await f.ingest("raw/1", mime({ attachment: gz(xml) }));
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 500, "capped at 500 distinct rows");
	assert.equal(f.q("SELECT record_count, message_count FROM deliverability_reports")[0].record_count, 900);
	assert.ok(f.batches.length >= 10 && f.batches.every((size) => size <= 50), JSON.stringify(f.batches));
	assert.ok(Math.max(...f.binds) < 100, `max binds ${Math.max(...f.binds)}`);
	assert.match(f.q("SELECT error FROM deliverability_reports")[0].error, /truncated/i);
});

test("when writing aggregates fails the report is marked failed and a redelivery does not double count", async (t) => {
	const f = await fixture(t);
	const realBatch = f.env.DB.batch;
	let fail = true;
	f.env.DB = new Proxy(f.env.DB, { get(target, key) { if (key === "batch" && fail) return async () => { throw new Error("D1 unavailable"); }; return typeof target[key] === "function" ? target[key].bind(target) : target[key]; } });
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	fail = false;
	assert.equal(f.q("SELECT status FROM deliverability_reports")[0].status, "failed");
	await f.ingest("raw/1", mime({ attachment: gz(google) }));
	assert.equal(f.q("SELECT count(*) AS n FROM dmarc_daily_stats")[0].n, 0);
	void realBatch;
});

test("an infrastructure error before anything is written is thrown so the queue retries", async (t) => {
	const f = await fixture(t);
	f.put("raw/1", mime({ attachment: gz(google) }));
	const env = { ...f.env, DB: { prepare() { throw new Error("D1 unavailable"); } } };
	await assert.rejects(ingestReportMail(env, { domainId: "d1", hostname: "example.com" }, { rawR2Key: "raw/1", authenticated: true, from: "a@google.com" }, { now: NOW }), /D1 unavailable/);
});

test("matchReportAddress finds only the reserved local part on a domain with reports enabled", async (t) => {
	const f = await fixture(t);
	assert.equal(REPORT_ADDRESS_LOCAL_PART, "mailflare-reports");
	assert.deepEqual(await matchReportAddress(f.env, "mailflare-reports@example.com"), { domainId: "d1", hostname: "example.com" });
	assert.deepEqual(await matchReportAddress(f.env, "MailFlare-Reports@EXAMPLE.com"), { domainId: "d1", hostname: "example.com" });
	assert.equal(await matchReportAddress(f.env, "kevin@example.com"), null);
	assert.equal(await matchReportAddress(f.env, "mailflare-reports@other.org"), null, "reports not enabled for that domain");
	assert.equal(await matchReportAddress(f.env, "mailflare-reports@unknown.net"), null);
	assert.equal(await matchReportAddress(f.env, "mailflare-reports+tag@example.com"), null);
	const off = await fixture(t, { enabled: false });
	assert.equal(await matchReportAddress(off.env, "mailflare-reports@example.com"), null);
});

test("matchReportAddress is off when the migration has not been applied", async () => {
	const failing = { DB: { prepare() { throw new Error("no such table: domain_deliverability"); } } };
	assert.equal(await matchReportAddress(failing, "mailflare-reports@example.com"), null);
	assert.equal(await matchReportAddress(failing, "kevin@example.com"), null);
});

test("the reserved local part is refused for a mailbox or alias only while reports are on for that domain", async (t) => {
	const f = await fixture(t);
	assert.equal(await isReportAddressReserved(f.env, "d1", "mailflare-reports"), true);
	assert.equal(await isReportAddressReserved(f.env, "d1", " MailFlare-Reports "), true);
	assert.equal(await isReportAddressReserved(f.env, "d1", "kevin"), false);
	assert.equal(await isReportAddressReserved(f.env, "d2", "mailflare-reports"), false, "reports were never turned on for d2");
	const off = await fixture(t, { enabled: false });
	assert.equal(await isReportAddressReserved(off.env, "d1", "mailflare-reports"), false);
	assert.equal(await isReportAddressReserved({ DB: { prepare() { throw new Error("no such table: domain_deliverability"); } } }, "d1", "mailflare-reports"), false);
});
