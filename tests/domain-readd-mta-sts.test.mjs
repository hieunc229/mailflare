import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-readd-sts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// Cloudflare and the DNS resolver are stubbed; the database, the MTA-STS guard and the republish run for real.
const mocks = {
	"@/lib/cloudflare-api": "export const disableEmailRouting=async()=>{},getEmailRoutingDns=async()=>{},getEmailRoutingSettings=async()=>{},getSendingSubdomainDns=async()=>{},deleteSendingSubdomain=async()=>{},listSendingSubdomains=async()=>{},ensureEmailRoutingRuleToWorker=async()=>{},deleteEmailRoutingRuleForAddress=async()=>{};",
	"@/lib/cloudflare-dns": "export const listMxRecords=async()=>[{priority:10,content:'new.mx.cloudflare.net'}];export const listDnsRecords=async()=>[{id:'sts1',content:'v=STSv1; id=20251119000000'}];export const createDnsRecord=async()=>{};export const updateDnsRecord=async(e,z,id,r)=>{globalThis.__dns.push(`update ${id} ${r.content}`)};export const deleteDnsRecord=async()=>{};",
	"@/lib/dns-query": "export const queryDns=async()=>[]",
	"@/lib/mailboxes/domain-addresses": "export async function ensureMailboxDomainRouting(){}",
	"@/lib/domains/cloudflare-cleanup": "export async function deleteEmailRoutingRulesForDomain(){}",
	"@/lib/domains/provision": "export const isManualZone=(z)=>z==='manual';export async function provisionDomainOnCloudflare(){globalThis.__provisioned++;return {hostname:'example.com',zone:{id:'zone1'},routingEnabled:true,sendingEnabled:false,sendingRequested:false,routingStatus:'enabled',sendingSubdomainTag:null,changes:{}}}",
	"@/lib/domains/manual-dns": "export const getManualDomainDns=()=>{}",
	"@/lib/domains/rollback": "export async function rollbackDomainProvisioning(){}",
	"@/lib/domains/sending-status": "export const findSendingSubdomain=()=>null",
	"@/lib/domains/preflight": "export async function preflightDomain(){}",
};
const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
await build({
	stdin: { contents: "export { addDomainForUser } from './src/lib/domains/service';export { MtaStsBlockedError } from './src/lib/deliverability/mta-sts-guard';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "service.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), alias: { "@": join(root, "src") },
	packages: "external", logLevel: "silent",
	plugins: [{ name: "mock-deps", setup(builder) {
		builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
});
await build({
	entryPoints: { database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const service = await load("service");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function fixture(t, mode) {
	globalThis.__provisioned = 0;
	globalThis.__dns = [];
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = 1_700_000_000;
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, receiving_provider, created_at) VALUES ('d1', 'u1', 'example.com', 'zone1', 'resend', ?)").run(now);
	database.db.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age) VALUES ('d1', ?, ?, '20251119000000', '[\"old.mx.cloudflare.net\"]', 604800)").run(now, mode);
	return { env: { DB: database }, raw: database.db };
}

test("re-adding a domain whose policy is enforced is refused before Cloudflare or the row is touched", async (t) => {
	const f = await fixture(t, "enforce");
	await assert.rejects(service.addDomainForUser(f.env, "u1", "example.com", { replaceMxRecords: true }), (error) => error instanceof service.MtaStsBlockedError && error.status === 409 && error.code === "MTA_STS_ENFORCED");
	assert.equal(globalThis.__provisioned, 0);
	assert.equal(f.raw.prepare("SELECT receiving_provider AS p FROM domains WHERE id = 'd1'").get().p, "resend");
	assert.deepEqual(globalThis.__dns, []);
});

test("re-adding a domain in testing mode publishes the policy again with the zone's MX list under a new id", async (t) => {
	const f = await fixture(t, "testing");
	await service.addDomainForUser(f.env, "u1", "example.com", { replaceMxRecords: true });
	assert.equal(globalThis.__provisioned, 1);
	const row = f.raw.prepare("SELECT mta_sts_policy_id AS id, mta_sts_mx AS mx FROM domain_deliverability WHERE domain_id = 'd1'").get();
	assert.notEqual(row.id, "20251119000000");
	assert.deepEqual(JSON.parse(row.mx), ["new.mx.cloudflare.net"]);
	assert.equal(globalThis.__dns.length, 1);
	assert.match(globalThis.__dns[0], /^update sts1 v=STSv1; id=\d{14}$/);
});
