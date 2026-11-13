import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-domain-add-sending-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});export const and=(...a)=>({and:a});export const ne=(c,v)=>({ne:[c,v]});export const inArray=(c,v)=>({inArray:[c,v]});",
	"@/db/schema": "export const domains={};export const mailboxes={};",
	"@/db": "const rows={from(){return rows},where(){return rows},limit(){return Promise.resolve([])}};export function getDb(){return {select(){return rows}}}",
	"@/lib/mailboxes/domain-addresses": "export async function ensureMailboxDomainRouting(){}",
	"@/lib/ids": "export const newId=(p)=>p",
	"@/lib/cloudflare-api": "export const disableEmailRouting=async()=>{},getEmailRoutingDns=async()=>{},getEmailRoutingSettings=async()=>{},getSendingSubdomainDns=async()=>{},deleteSendingSubdomain=async()=>{},listSendingSubdomains=async()=>{};",
	"@/lib/domains/cloudflare-cleanup": "export async function deleteEmailRoutingRulesForDomain(){}",
	"@/lib/domains/provision": "export const isManualZone=()=>false;export async function provisionDomainOnCloudflare(env,hostname,options){globalThis.__provisionOptions=options;throw new Error('stop')}",
	"@/lib/domains/manual-dns": "export const getManualDomainDns=()=>{}",
	"@/lib/domains/rollback": "export async function rollbackDomainProvisioning(){}",
	"@/lib/domains/sending-status": "export const findSendingSubdomain=()=>null",
	"@/lib/domains/preflight": "export async function preflightDomain(){}",
};
await build({
	stdin: { contents: "export { addDomainForUser } from './src/lib/domains/service';", resolveDir: root, loader: "ts" },
	outfile: join(outDir, "service.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const { addDomainForUser } = await import(pathToFileURL(join(outDir, "service.mjs")).href);

test("confirming the MX replacement reaches the sending step when another service receives mail", async () => {
	await assert.rejects(addDomainForUser({}, "u1", "example.com", { receivingProvider: "resend", sendingProvider: "cloudflare", replaceMxRecords: true }), /stop/);
	assert.equal(globalThis.__provisionOptions.enableSending, true);
	assert.equal(globalThis.__provisionOptions.enableRouting, false);
	assert.equal(globalThis.__provisionOptions.replaceMxRecords, true);
});
