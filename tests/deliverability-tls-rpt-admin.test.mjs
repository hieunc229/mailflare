import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tls-rpt-admin-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { admin: join(root, "src/lib/deliverability/tls-rpt-admin.ts"), reports: join(root, "src/lib/deliverability/reports-admin.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const admin = await load("admin");
const reports = await load("reports");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const ADDRESS = "mailflare-reports@example.com";
const NAME = "_smtp._tls.example.com";

async function fixture(t, { record = null, zoneId = "zone1", reportsEnabled = true, failDns = false } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, receiving_provider, created_at) VALUES ('d1', 'u1', 'example.com', ?, 'cloudflare', ?)").run(zoneId, now);
	if (reportsEnabled !== null) database.db.prepare("INSERT INTO domain_deliverability (domain_id, reports_enabled, updated_at) VALUES ('d1', ?, ?)").run(reportsEnabled ? 1 : 0, now);
	const calls = [];
	let current = record;
	const records = () => (current === null ? [] : [].concat(current));
	const deps = {
		async listTxt(_env, _zone, name) { calls.push(`list ${name}`); return records().map((content, index) => ({ id: `rec${index}`, content })); },
		async queryTxt(name) { calls.push(`query ${name}`); return records(); },
		async deleteTxt(_env, _zone, id) { calls.push(`delete ${id}`); if (failDns) throw new Error("dns down"); current = null; },
		async createTxt(_env, _zone, name, content) { calls.push(`create ${name} ${content}`); if (failDns) throw new Error("dns down"); current = content; },
		async updateTxt(_env, _zone, id, content) { calls.push(`update ${id} ${content}`); if (failDns) throw new Error("dns down"); current = content; },
		async ensureRoute() { throw new Error("TLS-RPT never touches routing"); },
		async deleteRoute() { throw new Error("TLS-RPT never touches routing"); },
	};
	const domain = database.db.prepare("SELECT id, hostname, zone_id AS zoneId, receiving_provider AS receivingProvider FROM domains WHERE id = 'd1'").get();
	return { env: { DB: database }, domain, deps, calls, current: () => current, row: () => database.db.prepare("SELECT * FROM domain_deliverability WHERE domain_id = 'd1'").get() };
}

test("turning TLS reports on creates the _smtp._tls record at the shared report address", async (t) => {
	const f = await fixture(t);
	const result = await admin.updateTlsRpt(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(result.kind, "ok");
	assert.deepEqual(result.plan, { address: ADDRESS, before: null, after: `v=TLSRPTv1; rua=mailto:${ADDRESS}`, changed: true, manual: false });
	assert.deepEqual(f.calls, [`list ${NAME}`, `create ${NAME} v=TLSRPTv1; rua=mailto:${ADDRESS}`]);
	assert.equal(f.row().tls_rpt_enabled, 1);
	assert.equal(result.state.enabled, true);
});

test("an existing record keeps its destinations: our address is appended in place", async (t) => {
	const f = await fixture(t, { record: "v=TLSRPTv1; rua=https://reports.vendor.example/tls" });
	const result = await admin.updateTlsRpt(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(result.kind, "ok");
	assert.equal(f.current(), `v=TLSRPTv1; rua=https://reports.vendor.example/tls,mailto:${ADDRESS}`);
	assert.deepEqual(f.calls.at(-1), `update rec0 ${f.current()}`);
});

test("turning on twice changes no DNS the second time", async (t) => {
	const f = await fixture(t, { record: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
	const result = await admin.updateTlsRpt(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(result.plan.changed, false);
	assert.deepEqual(f.calls, [`list ${NAME}`]);
	assert.equal(f.row().tls_rpt_enabled, 1);
});

test("TLS reports need DMARC reports on first, because they share the address and its routing", async (t) => {
	for (const reportsEnabled of [false, null]) {
		const f = await fixture(t, { reportsEnabled });
		const result = await admin.updateTlsRpt(f.env, f.domain, { enabled: true }, f.deps);
		assert.deepEqual([result.kind, result.status, result.code], ["error", 409, "REPORTS_REQUIRED"]);
		assert.deepEqual(f.calls, []);
	}
});

test("turning off removes only our address; a record that held only ours is deleted", async (t) => {
	const shared = await fixture(t, { record: `v=TLSRPTv1; rua=https://v.example/tls,mailto:${ADDRESS}` });
	await shared.env.DB.db.prepare("UPDATE domain_deliverability SET tls_rpt_enabled = 1").run();
	const off = await admin.updateTlsRpt(shared.env, shared.domain, { enabled: false }, shared.deps);
	assert.equal(off.kind, "ok");
	assert.equal(shared.current(), "v=TLSRPTv1; rua=https://v.example/tls");
	assert.equal(shared.row().tls_rpt_enabled, 0);
	const only = await fixture(t, { record: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
	const gone = await admin.updateTlsRpt(only.env, only.domain, { enabled: false }, only.deps);
	assert.equal(gone.plan.after, null);
	assert.equal(only.current(), null);
	assert.deepEqual(only.calls.at(-1), "delete rec0");
	const none = await fixture(t);
	assert.equal((await admin.updateTlsRpt(none.env, none.domain, { enabled: false }, none.deps)).plan.changed, false);
});

test("turning off deletes the record when no rua remains, even with other tags left; a record that never held our address is untouched", async (t) => {
	const tagged = await fixture(t, { record: `v=TLSRPTv1; ext=1; rua=mailto:${ADDRESS}` });
	const gone = await admin.updateTlsRpt(tagged.env, tagged.domain, { enabled: false }, tagged.deps);
	assert.equal(gone.plan.after, null);
	assert.equal(tagged.current(), null);
	const foreignBare = await fixture(t, { record: "v=TLSRPTv1" });
	const kept = await admin.updateTlsRpt(foreignBare.env, foreignBare.domain, { enabled: false }, foreignBare.deps);
	assert.equal(kept.plan.changed, false);
	assert.equal(foreignBare.current(), "v=TLSRPTv1", "a record without our address is not ours to delete");
});

test("more than one TLSRPT record, an unreadable zone or a failing write leave DNS and the setting as they were", async (t) => {
	const many = await fixture(t, { record: ["v=TLSRPTv1; rua=mailto:a@x.org", "v=TLSRPTv1; rua=mailto:b@x.org"] });
	assert.deepEqual(await admin.updateTlsRpt(many.env, many.domain, { enabled: true }, many.deps).then((r) => [r.status, r.code]), [409, "MULTIPLE_TLSRPT_RECORDS"]);
	const failing = await fixture(t, { failDns: true });
	assert.deepEqual(await admin.updateTlsRpt(failing.env, failing.domain, { enabled: true }, failing.deps).then((r) => [r.status, r.code]), [502, "DNS_FAILED"]);
	assert.equal(failing.row().tls_rpt_enabled, 0);
	const unreadable = await fixture(t);
	unreadable.deps.listTxt = async () => { throw new Error("cf down"); };
	assert.deepEqual(await admin.updateTlsRpt(unreadable.env, unreadable.domain, { enabled: true }, unreadable.deps).then((r) => [r.status, r.code]), [502, "DNS_FAILED"]);
});

test("a manual zone is not edited: the value to publish is returned and the setting is saved", async (t) => {
	const f = await fixture(t, { zoneId: "manual" });
	const result = await admin.updateTlsRpt(f.env, f.domain, { enabled: true }, f.deps);
	assert.deepEqual([result.plan.manual, result.plan.after], [true, `v=TLSRPTv1; rua=mailto:${ADDRESS}`]);
	assert.deepEqual(f.calls, [`query ${NAME}`]);
	assert.equal(f.row().tls_rpt_enabled, 1);
});

test("the body must be { enabled: boolean }", async (t) => {
	const f = await fixture(t);
	for (const body of [null, {}, { enabled: "yes" }, [], "x"]) assert.equal((await admin.updateTlsRpt(f.env, f.domain, body, f.deps)).code, "INVALID_BODY");
});

test("DMARC reports cannot be turned off while TLS reports are on, because they share the address", async (t) => {
	const f = await fixture(t);
	f.env.DB.db.prepare("UPDATE domain_deliverability SET tls_rpt_enabled = 1").run();
	const reportsDeps = { ...f.deps, listTxt: async () => [{ id: "r", content: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` }] };
	const result = await reports.updateReports(f.env, f.domain, { enabled: false }, reportsDeps);
	assert.deepEqual([result.kind, result.status, result.code], ["error", 409, "TLS_RPT_ON"]);
	assert.equal(f.row().reports_enabled, 1);
});
