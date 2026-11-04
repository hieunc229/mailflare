import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A domain added with "Skip DNS setup" starts as `pending`, and inbound routing
// only resolves `active` domains (#174). Turning on receiving later must activate it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-receiving-status-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const or=(...a)=>({or:a});export const ne=(c,v)=>({ne:[c,v]});",
	"@/db/schema": "export const domains={id:'domains.id',userId:'domains.userId',zoneId:'domains.zoneId'};export const mailboxes={id:'m.id',domainId:'m.domainId',localPart:'m.localPart',useAllDomains:'m.useAllDomains'};",
	"@/db": "const rows={from(){return rows;},innerJoin(){return rows;},where(){return Promise.resolve([]);}};export function getDb(){return {select(){return rows;},update(){return {set(values){return {where(){globalThis.__updates.push(values);}}}}}}}",
	"@/lib/cloudflare-api": "export async function enableEmailRouting(){return globalThis.__routing;}export async function getZone(){return {name:'example.com'};}export async function disableEmailRouting(){}",
	"@/lib/cloudflare-dns": "export async function createDnsRecord(){}export async function listDnsRecords(){return [];}export async function deleteDnsRecord(){}",
	"@/lib/domains/catch-all-routing": "export async function ensureEmailRoutingCatchAllToWorker(){}",
	"@/lib/domains/provision": "export const isManualZone=(z)=>z==='manual';export const shouldBindEmailCatchAllToWorker=()=>false;",
	"@/lib/domains/sending-subdomain": "export async function ensureSendingSubdomain(){return {subdomain:globalThis.__subdomain};}",
	"@/lib/domains/cloudflare-cleanup": "export async function deleteEmailRoutingRulesForDomain(){}",
	"@/lib/domains/mx-records": "export async function removeMxRecords(){}",
	"@/lib/domains/adopt-zone": "export async function adoptCloudflareZone(env,d){return d;}",
	"@/lib/domains/receiving-dns": "export async function listDomainMx(){return [];}export class MxConflictError extends Error{}",
	"@/lib/domains/resend-receiving": "export async function setupResendReceiving(){}export async function removeResendReceiving(){}export async function hasResendReceivingConfig(){return false;}",
	"@/lib/aws/ses-receiving": "export async function setupSesReceiving(){}export async function removeSesReceiving(){}export async function hasSesReceivingConfig(){return false;}",
	"@/lib/mailboxes/domain-addresses": "export async function ensureMailboxDomainRouting(){}",
};

await build({
	stdin: { contents: "export * from './src/lib/domains/dns-setup';export { setupReceiving } from './src/lib/domains/receiving';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "receiving.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-domain-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});

const { setupDomainDnsRecord, setupReceiving } = await import(pathToFileURL(join(outDir, "receiving.mjs")).href);
const skippedDomain = { id: "d1", userId: "u1", hostname: "example.com", zoneId: "zone-1", status: "pending", dnsSkipped: true, routingEnabled: false, routingStatus: null };

beforeEach(() => {
	globalThis.__updates = [];
	globalThis.__routing = { enabled: true, status: "ready" };
	globalThis.__subdomain = { tag: "tag", enabled: true };
});

test("enabling MX routing activates a pending skip-DNS domain", async () => {
	await setupDomainDnsRecord({}, skippedDomain, "mx");
	assert.equal(globalThis.__updates.length, 1);
	assert.equal(globalThis.__updates[0].status, "active");
	assert.equal(globalThis.__updates[0].routingEnabled, true);
});

test("routing that did not enable leaves the status alone", async () => {
	globalThis.__routing = { enabled: false, status: "unconfigured" };
	await setupDomainDnsRecord({}, skippedDomain, "spf");
	assert.equal("status" in globalThis.__updates[0], false);
});

test("an enabled sending subdomain activates the domain", async () => {
	await setupDomainDnsRecord({}, skippedDomain, "dkim");
	assert.equal(globalThis.__updates[0].status, "active");
	globalThis.__updates = [];
	globalThis.__subdomain = { tag: "tag", enabled: false };
	await setupDomainDnsRecord({}, skippedDomain, "dkim");
	assert.equal("status" in globalThis.__updates[0], false);
});

test("Cloudflare, Resend and SES receiving setup all activate the domain", async () => {
	for (const provider of ["cloudflare", "resend", "ses"]) {
		globalThis.__updates = [];
		await setupReceiving({}, skippedDomain, provider, "https://mail.example.com", { replaceMx: false });
		assert.ok(globalThis.__updates.some((values) => values.status === "active"), provider);
	}
});
