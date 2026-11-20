import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mta-sts-guard-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { guard: join(root, "src/lib/deliverability/mta-sts-guard.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const guard = await load("guard");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const NOW = new Date("2025-11-19T12:34:56Z");
const ADDRESS = "mailflare-reports@example.com";

async function fixture(t, { zoneId = "zone1", row = null, tlsRecord = null, failDns = false, zoneMx = ["10 new1.mx.cloudflare.net.", "20 new2.mx.cloudflare.net."] } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(NOW.getTime() / 1000);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', ?, ?)").run(zoneId, now);
	if (row) database.db.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age, tls_rpt_enabled) VALUES ('d1', ?, ?, ?, ?, 604800, ?)").run(now, row.mode ?? "none", row.policyId ?? null, row.mx ?? '["old.mx.cloudflare.net"]', row.tlsRpt ? 1 : 0);
	const state = { sts: row?.policyId ? `v=STSv1; id=${row.policyId}` : null, tls: tlsRecord, calls: [] };
	const txt = (name) => (name.startsWith("_mta-sts") ? state.sts : state.tls);
	const deps = {
		async listTxt(_e, _z, name) { const value = txt(name); return value === null ? [] : [{ id: name.startsWith("_mta-sts") ? "sts1" : "tls1", content: value }]; },
		async queryTxt(name) { const value = txt(name); return value === null ? [] : [value]; },
		async createTxt(_e, _z, name, content) { state.calls.push(`create ${name}`); if (name.startsWith("_mta-sts")) state.sts = content; else state.tls = content; },
		async updateTxt(_e, _z, id, content) { state.calls.push(`update ${id} ${content}`); if (failDns) throw new Error("dns down"); if (id === "sts1") state.sts = content; else state.tls = content; },
		async deleteTxt(_e, _z, id) { state.calls.push(`delete ${id}`); if (failDns) throw new Error("dns down"); if (id === "tls1") state.tls = null; else state.sts = null; },
		async ensureRoute() {}, async deleteRoute() {},
		async queryMx() { throw new Error("republish must read the zone, not a resolver"); },
		async zoneMx() { return zoneMx; },
	};
	const domain = database.db.prepare("SELECT id, hostname, zone_id AS zoneId FROM domains WHERE id = 'd1'").get();
	return { env: { DB: database }, domain, deps, state, raw: database.db, row: () => database.db.prepare("SELECT * FROM domain_deliverability WHERE domain_id = 'd1'").get() };
}
const code = async (promise) => promise.then(() => null, (error) => (error instanceof guard.MtaStsBlockedError ? [error.status, error.code] : Promise.reject(error)));

test("MX changes are refused while the policy is enforce, and only then", async (t) => {
	assert.deepEqual(await code(guard.assertMxChangeAllowed((await fixture(t, { row: { mode: "enforce", policyId: "20251119000000" } })).env, { id: "d1" })), [409, "MTA_STS_ENFORCED"]);
	for (const row of [null, { mode: "testing", policyId: "20251119000000" }, { mode: "none", policyId: "20251119000000" }, { mode: "none", policyId: null }]) {
		const f = await fixture(t, { row });
		assert.equal(await code(guard.assertMxChangeAllowed(f.env, { id: "d1" })), null, JSON.stringify(row));
	}
});

test("before the migration there is nothing to protect and nothing blocks", async (t) => {
	const f = await fixture(t, { row: { mode: "enforce", policyId: "20251119000000" } });
	f.raw.exec("DROP TABLE domain_deliverability");
	assert.equal(await code(guard.assertMxChangeAllowed(f.env, { id: "d1" })), null);
	assert.equal(await code(guard.assertDomainRemovable(f.env, f.domain, f.deps)), null);
});

test("in testing mode an MX change republishes the policy with the zone's MX list under a new id", async (t) => {
	const f = await fixture(t, { row: { mode: "testing", policyId: "20251119000000" } });
	await guard.republishMtaStsAfterMxChange(f.env, f.domain, f.deps, NOW);
	const row = f.row();
	assert.deepEqual(JSON.parse(row.mta_sts_mx), ["new1.mx.cloudflare.net", "new2.mx.cloudflare.net"]);
	assert.equal(row.mta_sts_policy_id, "20251119123456");
	assert.equal(row.mta_sts_mode, "testing");
	assert.equal(f.state.sts, "v=STSv1; id=20251119123456");
});

test("off, retiring, enforce and manual-zone domains are left alone after an MX change; a failure is logged, not thrown", async (t) => {
	for (const [row, zoneId] of [[null], [{ mode: "none", policyId: "20251119000000" }], [{ mode: "enforce", policyId: "20251119000000" }], [{ mode: "testing", policyId: "20251119000000" }, "manual"]]) {
		const f = await fixture(t, { row, zoneId });
		const before = f.row();
		await guard.republishMtaStsAfterMxChange(f.env, f.domain, f.deps, NOW);
		assert.deepEqual(f.row(), before);
		assert.deepEqual(f.state.calls, []);
	}
	const f = await fixture(t, { row: { mode: "testing", policyId: "20251119000000" }, failDns: true });
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	await guard.republishMtaStsAfterMxChange(f.env, f.domain, f.deps, NOW);
	assert.equal(f.row().mta_sts_policy_id, "20251119000000", "a failed republish changed nothing");
});

test("a domain with a published policy cannot be deleted: testing, enforce and the removal period all block", async (t) => {
	for (const mode of ["testing", "enforce", "none"]) {
		const f = await fixture(t, { row: { mode, policyId: "20251119000000" } });
		assert.deepEqual(await code(guard.assertDomainRemovable(f.env, f.domain, f.deps)), [409, "MTA_STS_PUBLISHED"], mode);
	}
	for (const row of [null, { mode: "none", policyId: null }]) {
		const f = await fixture(t, { row });
		assert.equal(await code(guard.assertDomainRemovable(f.env, f.domain, f.deps)), null);
	}
});

test("deleting a domain removes our address from _smtp._tls first, keeping other destinations; a record that held only ours is deleted", async (t) => {
	const shared = await fixture(t, { row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=https://v.example/tls,mailto:${ADDRESS}` });
	assert.equal(await code(guard.assertDomainRemovable(shared.env, shared.domain, shared.deps)), null);
	assert.equal(shared.state.tls, "v=TLSRPTv1; rua=https://v.example/tls");
	assert.equal(shared.row().tls_rpt_enabled, 0);
	const only = await fixture(t, { row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
	assert.equal(await code(guard.assertDomainRemovable(only.env, only.domain, only.deps)), null);
	assert.equal(only.state.tls, null);
});

test("deleting a domain waits when the TLS-RPT record cannot be cleaned: a manual zone, or DNS refusing", async (t) => {
	const manual = await fixture(t, { zoneId: "manual", row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
	assert.deepEqual(await code(guard.assertDomainRemovable(manual.env, manual.domain, manual.deps)), [409, "TLS_RPT_ENABLED"]);
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	const down = await fixture(t, { row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=mailto:${ADDRESS}`, failDns: true });
	assert.deepEqual(await code(guard.assertDomainRemovable(down.env, down.domain, down.deps)), [409, "TLS_RPT_ENABLED"]);
	assert.equal(down.row().tls_rpt_enabled, 1);
});

test("a zone Cloudflare no longer serves (404, 403) is treated like a manual zone: TLS reports go off in the app, the record is the admin's, deleting waits for that", async (t) => {
	const gone = (status) => Object.assign(new Error("zone unavailable"), { name: "CloudflareApiError", status });
	for (const status of [404, 403]) {
		const f = await fixture(t, { row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
		f.deps.listTxt = async () => { throw gone(status); };
		assert.deepEqual(await code(guard.assertDomainRemovable(f.env, f.domain, f.deps)), [409, "TLS_RPT_ENABLED"], String(status));
		assert.equal(f.row().tls_rpt_enabled, 0);
		assert.equal(await code(guard.assertDomainRemovable(f.env, f.domain, f.deps)), null);
		assert.equal(f.state.tls, `v=TLSRPTv1; rua=mailto:${ADDRESS}`, "no record was written");
	}
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	const broken = await fixture(t, { row: { tlsRpt: true }, tlsRecord: `v=TLSRPTv1; rua=mailto:${ADDRESS}` });
	broken.deps.listTxt = async () => { throw gone(500); };
	assert.deepEqual(await code(guard.assertDomainRemovable(broken.env, broken.domain, broken.deps)), [409, "TLS_RPT_ENABLED"]);
	assert.equal(broken.row().tls_rpt_enabled, 1);
});

test("force cleanup removes what DNS allows and lists the rest, with the date senders may cache the policy until", async (t) => {
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	const tls = `v=TLSRPTv1; rua=mailto:${ADDRESS}`;
	const ok = await fixture(t, { row: { mode: "enforce", policyId: "20251119000000", tlsRpt: true }, tlsRecord: tls });
	assert.deepEqual((await guard.forceCleanupMtaSts(ok.env, ok.domain, ok.deps, NOW)).leftovers.map((record) => record.name), ["mta-sts.example.com"]);
	assert.deepEqual([ok.state.sts, ok.state.tls], [null, null]);
	const down = await fixture(t, { row: { mode: "enforce", policyId: "20251119000000", tlsRpt: true }, tlsRecord: tls, failDns: true });
	const result = await guard.forceCleanupMtaSts(down.env, down.domain, down.deps, NOW);
	assert.deepEqual(result.leftovers.map((record) => record.name), ["_mta-sts.example.com", "mta-sts.example.com", "_smtp._tls.example.com"]);
	assert.equal(result.cachedUntil, new Date(NOW.getTime() + 604800 * 1000).toISOString());
	const manual = await fixture(t, { zoneId: "manual", row: { mode: "testing", policyId: "20251119000000" } });
	assert.deepEqual((await guard.forceCleanupMtaSts(manual.env, manual.domain, manual.deps, NOW)).leftovers.map((record) => record.name), ["_mta-sts.example.com", "mta-sts.example.com"]);
	const none = await fixture(t, {});
	assert.deepEqual(await guard.forceCleanupMtaSts(none.env, none.domain, none.deps, NOW), { leftovers: [], cachedUntil: null });
});
