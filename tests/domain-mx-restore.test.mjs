import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Replacing another service's MX records must not leave the domain without MX:
// Cloudflare-managed paths delete first and restore on failure (and report a failed
// restore); publishMx creates the new record before deleting anything.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-mx-restore-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(name, entry, mocks) {
	await build({
		stdin: { contents: entry, resolveDir: root, loader: "ts" },
		outfile: join(outDir, `${name}.mjs`),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { "@": join(root, "src") },
		plugins: [{
			name: "mock-deps",
			setup(builder) {
				const names = Object.keys(mocks).map((key) => key.replace(/[/.-]/g, "\\$&")).join("|");
				builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
				builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
			},
		}],
		logLevel: "silent",
	});
	return import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
}

const oldMx = { id: "mx1", type: "MX", name: "example.com", content: "mx.old-provider.test", priority: 10, ttl: 3600 };

const flow = await bundle(
	"flow",
	"export { setupCloudflareReceiving } from './src/lib/domains/receiving';export { setupDomainDnsRecord } from './src/lib/domains/dns-setup';",
	{
		"@/lib/deliverability/mta-sts-guard": "export const assertMxChangeAllowed=async()=>{};export const republishMtaStsAfterMxChange=async()=>{};export const assertDomainRemovable=async()=>{};",
		"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const or=(...a)=>({or:a});export const ne=(c,v)=>({ne:[c,v]});",
		"@/db/schema": "export const domains={id:'domains.id'};export const mailboxes={};",
		"@/db": "export function getDb(){return {select(){throw new Error('unexpected')},update(){return {set(){return {where(){}}}}}}}",
		"@/lib/cloudflare-api": "export async function enableEmailRouting(){globalThis.__mx.push({id:'cfmx',content:'route1.mx.cloudflare.net',priority:1});throw new Error('routing failed')}export async function getZone(){return {name:'example.com'}}export async function disableEmailRouting(){}",
		"@/lib/cloudflare-dns": "export async function createDnsRecord(env,zone,input){if(globalThis.__failRestore)throw new Error('create rejected');globalThis.__restored.push(input)}export async function listDnsRecords(){return []}export async function listMxRecords(){return globalThis.__mx}export async function deleteDnsRecord(env,zone,id){globalThis.__deleted.push(id);globalThis.__mx=globalThis.__mx.filter((r)=>r.id!==id)}",
		"@/lib/domains/catch-all-routing": "export async function ensureEmailRoutingCatchAllToWorker(){}",
		"@/lib/domains/provision": "export const isManualZone=(z)=>z==='manual';export const shouldBindEmailCatchAllToWorker=()=>false;",
		"@/lib/domains/sending-subdomain": "export async function ensureSendingSubdomain(env,zoneId,hostname,options){const mx=globalThis.__mx.filter((r)=>!r.content.endsWith('.mx.cloudflare.net'));for(const r of mx){options.deletedMx?.push(r);globalThis.__mx=globalThis.__mx.filter((x)=>x.id!==r.id)}throw new Error('sending failed')}",
		"@/lib/domains/cloudflare-cleanup": "export async function deleteEmailRoutingRulesForDomain(){}",
		"@/lib/domains/adopt-zone": "export async function adoptCloudflareZone(env,d){return d;}",
		"@/lib/domains/receiving-dns": "export async function listDomainMx(){return globalThis.__mx}export class MxConflictError extends Error{}",
		"@/lib/domains/resend-receiving": "export async function setupResendReceiving(){}export async function removeResendReceiving(){}export async function hasResendReceivingConfig(){return false}",
		"@/lib/aws/ses-receiving": "export async function setupSesReceiving(){}export async function removeSesReceiving(){}export async function hasSesReceivingConfig(){return false}",
		"@/lib/mailboxes/domain-addresses": "export async function ensureMailboxDomainRouting(){}",
	},
);

const publish = await bundle(
	"publish",
	"export { publishMx } from './src/lib/domains/receiving-dns';",
	{
		"@/lib/dns-query": "export async function queryDns(){return []}",
		"@/lib/cloudflare-dns": "export async function listMxRecords(){return [globalThis.__oldMx]}export async function deleteDnsRecord(env,zone,id){globalThis.__log.push('delete '+id)}export async function createDnsRecord(env,zone,input){globalThis.__log.push('create '+input.content);if(globalThis.__createFails)throw new Error('create rejected')}",
		"@/lib/domains/provision": "export const isManualZone=(z)=>z==='manual';",
	},
);

const domain = { id: "d1", userId: "u1", hostname: "example.com", zoneId: "zone-1", routingEnabled: false, routingStatus: null };

beforeEach(() => {
	globalThis.__oldMx = oldMx;
	globalThis.__mx = [oldMx];
	globalThis.__restored = [];
	globalThis.__deleted = [];
	globalThis.__log = [];
	globalThis.__failRestore = false;
	globalThis.__createFails = false;
});

test("replacing MX restores the old records and drops the half-created Cloudflare MX when routing fails", async () => {
	await assert.rejects(flow.setupCloudflareReceiving({}, domain, { replaceMx: true }), /^Error: routing failed$/);
	assert.deepEqual(globalThis.__deleted, ["mx1", "cfmx"]);
	assert.deepEqual(globalThis.__restored.map((record) => record.content), ["mx.old-provider.test"]);
	assert.deepEqual(globalThis.__mx.map((record) => record.id), []);
});

test("a failed restore is raised, naming the records and carrying the original error", async () => {
	globalThis.__failRestore = true;
	await assert.rejects(flow.setupCloudflareReceiving({}, domain, { replaceMx: true }), (error) => {
		assert.equal(error.name, "MxRestoreError");
		assert.match(error.message, /routing failed/);
		assert.match(error.message, /mx\.old-provider\.test/);
		assert.ok(error.errors.some((reason) => reason.message === "routing failed"));
		return true;
	});
});

test("replacing MX restores the old records when the sending subdomain cannot be created", async () => {
	await assert.rejects(flow.setupDomainDnsRecord({}, domain, "dkim", { replaceMx: true }), /sending failed/);
	assert.deepEqual(globalThis.__restored.map((record) => record.id ?? record.content), ["mx.old-provider.test"]);
});

test("publishMx creates the new MX before deleting the old one", async () => {
	await publish.publishMx({}, domain, "inbound.new-provider.test", { replace: true });
	assert.deepEqual(globalThis.__log, ["create inbound.new-provider.test", "delete mx1"]);
});

test("publishMx deletes nothing when the new record is rejected", async () => {
	globalThis.__createFails = true;
	await assert.rejects(publish.publishMx({}, domain, "inbound.new-provider.test", { replace: true }), /create rejected/);
	assert.deepEqual(globalThis.__log, ["create inbound.new-provider.test"]);
});
