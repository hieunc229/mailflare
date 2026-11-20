import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mta-sts-domain-guards-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: "export { setupReceiving, removeReceiving } from './src/lib/domains/receiving';export { setupDomainDnsRecord } from './src/lib/domains/dns-setup';export { removeDomainForUser } from './src/lib/domains/service';export { MtaStsBlockedError } from './src/lib/deliverability/mta-sts-guard';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "domains.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), alias: { "@": join(root, "src") },
	packages: "external", logLevel: "silent",
});
await build({
	entryPoints: { database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const domains = await load("domains");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function fixture(t, { mode, policyId = "20251119000000", provider = "cloudflare" } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = 1_700_000_000;
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, receiving_provider, created_at) VALUES ('d1', 'u1', 'example.com', 'zone1', ?, ?)").run(provider, now);
	if (mode) database.db.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age) VALUES ('d1', ?, ?, ?, '[\"mx.example.net\"]', 604800)").run(now, mode, policyId);
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (...args) => { calls.push(String(args[0])); throw new Error("no network in this test"); };
	t.after(() => { globalThis.fetch = realFetch; });
	const domain = database.db.prepare("SELECT id, user_id AS userId, hostname, zone_id AS zoneId, receiving_provider AS receivingProvider, routing_enabled AS routingEnabled FROM domains WHERE id = 'd1'").get();
	return { env: { DB: database }, domain, calls, raw: database.db };
}
const blockedCode = (promise) => promise.then(() => null, (error) => (error instanceof domains.MtaStsBlockedError ? error.code : Promise.reject(error)));

test("every action that changes the MX is refused before it touches anything while the policy is enforce", async (t) => {
	const f = await fixture(t, { mode: "enforce" });
	for (const provider of ["cloudflare", "resend", "ses"]) {
		assert.equal(await blockedCode(domains.setupReceiving(f.env, f.domain, provider, "https://app.example", { replaceMx: true })), "MTA_STS_ENFORCED", provider);
		assert.equal(await blockedCode(domains.removeReceiving(f.env, f.domain, provider)), "MTA_STS_ENFORCED", `remove ${provider}`);
	}
	for (const record of ["mx", "spf"]) assert.equal(await blockedCode(domains.setupDomainDnsRecord(f.env, f.domain, record)), "MTA_STS_ENFORCED", record);
	assert.equal(await blockedCode(domains.setupDomainDnsRecord(f.env, f.domain, "dkim", { replaceMx: true })), "MTA_STS_ENFORCED", "dkim replacing MX");
	assert.deepEqual(f.calls, [], "no Cloudflare, Resend or AWS request was made");
});

test("deleting a domain with a published policy is refused and the domain stays", async (t) => {
	for (const mode of ["testing", "enforce", "none"]) {
		const f = await fixture(t, { mode });
		assert.equal(await blockedCode(domains.removeDomainForUser(f.env, "u1", "d1")), "MTA_STS_PUBLISHED", mode);
		assert.equal(f.raw.prepare("SELECT count(*) AS n FROM domains").get().n, 1);
		assert.deepEqual(f.calls, []);
	}
});

test("a forced delete needs the typed host name; with it the domain goes even when DNS cannot be cleaned, and the leftovers come back and are audit-logged", async (t) => {
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	const f = await fixture(t, { mode: "enforce" });
	f.raw.prepare("UPDATE domain_deliverability SET tls_rpt_enabled = 1 WHERE domain_id = 'd1'").run();
	for (const confirm of [undefined, "", "other.example", 5]) {
		await assert.rejects(domains.removeDomainForUser(f.env, "u1", "d1", { confirm }), (e) => e.status === 400 && /example\.com/.test(e.message), String(confirm));
	}
	assert.equal(f.raw.prepare("SELECT count(*) AS n FROM domains").get().n, 1);
	assert.deepEqual(f.calls, []);
	const result = await domains.removeDomainForUser(f.env, "u1", "d1", { confirm: " Example.com " });
	assert.deepEqual(result.leftovers.map((record) => record.name), ["_mta-sts.example.com", "mta-sts.example.com", "_smtp._tls.example.com"]);
	assert.match(result.cachedUntil, /^\d{4}-\d\d-\d\dT/);
	assert.equal(f.raw.prepare("SELECT count(*) AS n FROM domains").get().n, 0);
	const audit = f.raw.prepare("SELECT actor_user_id AS actor, action, metadata FROM audit_logs").all();
	assert.equal(audit.length, 1);
	assert.deepEqual([audit[0].actor, audit[0].action], ["u1", "domain.force_delete"]);
	assert.deepEqual(JSON.parse(audit[0].metadata).leftovers, ["_mta-sts.example.com", "mta-sts.example.com", "_smtp._tls.example.com"]);
});
