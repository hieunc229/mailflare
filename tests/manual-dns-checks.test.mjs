import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-dns-bundle-"));

const mocks = {
	"drizzle-orm": "export const eq=(c,v)=>({eq:[c,v]});",
	"@/db/schema": "export const appSettings={id:'appSettings.id',resendWebhookSecret:'appSettings.resendWebhookSecret'};",
	"@/db": "const q={from(){return q;},where(){return q;},limit(){return Promise.resolve(globalThis.__settingsRows??[]);}};export function getDb(){return {select(){return q;},insert(){return {values(){return {onConflictDoUpdate(){return Promise.resolve();}}}}}}}",
	"@/lib/cloudflare-dns": "export async function createDnsRecord(){}export async function deleteDnsRecord(){}export async function listDnsRecords(){return [];}export async function listMxRecords(){return [];}",
	"@/lib/domains/provision": "export const isManualZone=(z)=>z==='manual';export const shouldBindEmailCatchAllToWorker=()=>false;",
	"@/lib/email/outbound-provider": "export async function getResendKeyStatus(){return globalThis.__resendKey??{configured:false,apiKey:null};}export async function getResendApiKey(){return 're_test';}",
	"@/lib/email/resend-api": `export class ResendRestrictedKeyError extends Error{}
		export async function findResendDomain(){return globalThis.__resendDomain??null;}
		export async function getResendDomain(){return globalThis.__resendDomain??null;}
		export async function listResendWebhooks(){return globalThis.__webhooks??[];}
		export async function createResendDomain(){return {id:"rd1"};}
		export async function createResendWebhook(){return {id:"w1",signing_secret:"s"};}
		export async function deleteResendDomain(){}export async function deleteResendWebhook(){}
		export async function updateResendCapabilities(){}export async function verifyResendDomain(){}`,
};

await build({
	stdin: {
		contents: `
			export { hasMx, hasMxMatching, isInboundSmtpMx } from "./src/lib/domains/receiving-dns.ts";
			export { auditDomainDns } from "./src/lib/domains/dns-audit.ts";
			export { getResendReceivingView } from "./src/lib/domains/resend-receiving.ts";
		`,
		resolveDir: root,
		sourcefile: "dns-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
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
const { hasMx, hasMxMatching, isInboundSmtpMx, auditDomainDns, getResendReceivingView } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
rmSync(bundleDirectory, { recursive: true, force: true });

const manualDomain = { hostname: "example.com", zoneId: "manual" };

function answerDns(answers) {
	const asked = [];
	globalThis.fetch = async (url) => {
		const parsed = new URL(url);
		const name = parsed.searchParams.get("name");
		asked.push(name);
		const data = answers[`${name}|${parsed.searchParams.get("type")}`];
		return Response.json(data === undefined ? { Status: 3 } : { Status: 0, Answer: data.map((value) => ({ name, type: 0, TTL: 60, data: value })) });
	};
	return asked;
}

const emptyView = { routing: { records: [], missing: [] }, sending: [] };

const resendDomain = (records, status = "pending") => ({
	id: "rd1",
	name: "example.com",
	status,
	capabilities: { sending: "enabled", receiving: "enabled" },
	records,
});
const mxRecord = (value, status = "pending") => ({ record: "MX", name: "example.com", type: "MX", value, priority: 10, status });

function stubResend(records, status = "pending") {
	globalThis.__resendKey = { configured: true, apiKey: "re_test", source: "settings" };
	globalThis.__resendDomain = resendDomain(records, status);
	globalThis.__webhooks = [{ id: "w1", endpoint: "https://app.example.com/api/inbound/resend" }];
	globalThis.__settingsRows = [{ secret: "whsec_test" }];
}

const mxStep = async () => (await getResendReceivingView({}, manualDomain, "https://app.example.com")).steps.find((step) => step.key === "mx");

test("a manual zone's MX is read from public DNS", async () => {
	answerDns({ "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] });
	assert.equal(await hasMx({}, manualDomain, "inbound-smtp.ap-northeast-1.amazonaws.com"), true);
	assert.equal(await hasMx({}, manualDomain, "mail.example.net"), false);
});

test("a manual zone with no MX answers false, and a failed lookup stays unknown", async () => {
	answerDns({});
	assert.equal(await hasMx({}, manualDomain, "mail.example.net"), false);
	globalThis.fetch = async () => { throw new Error("offline"); };
	assert.equal(await hasMx({}, manualDomain, "mail.example.net"), null);
});

test("hasMxMatching accepts any MX matching a provider's target shape", async () => {
	answerDns({ "example.com|MX": ["10 inbound-smtp.eu-west-1.amazonaws.com."] });
	assert.equal(await hasMxMatching({}, manualDomain, isInboundSmtpMx), true);
	assert.equal(await hasMxMatching({}, manualDomain, (target) => target.endsWith(".mx.cloudflare.net")), false);
	answerDns({});
	assert.equal(await hasMxMatching({}, manualDomain, isInboundSmtpMx), false);
});

test("SPF for a Resend sender is found on Resend's return-path subdomains", async () => {
	// send.<domain> carries the SPF TXT itself, or a CNAME whose target does;
	// either way the TXT lookup answers. Newer domains use rsend.<domain> too.
	answerDns({ "send.example.com|TXT": ["v=spf1 include:amazonses.com ~all"] });
	assert.equal((await auditDomainDns("example.com", emptyView, "resend")).spf.status, "ok");
	answerDns({ "rsend.example.com|TXT": ["v=spf1 ip4:1.2.3.4 ~all"] });
	assert.equal((await auditDomainDns("example.com", emptyView, "resend")).spf.status, "ok");
	answerDns({ "example.com|TXT": ["v=spf1 include:_spf.resend.com ~all"] });
	assert.equal((await auditDomainDns("example.com", emptyView, "resend")).spf.status, "ok");
	answerDns({});
	assert.equal((await auditDomainDns("example.com", emptyView, "resend")).spf.status, "missing");
	// Other senders still only look at the apex.
	answerDns({ "send.example.com|TXT": ["v=spf1 include:amazonses.com ~all"] });
	assert.equal((await auditDomainDns("example.com", emptyView, "cloudflare")).spf.status, "missing");
	assert.equal((await auditDomainDns("example.com", emptyView)).spf.status, "missing");
});

test("DKIM for a Resend domain is checked at Resend's selector when nothing else names one", async () => {
	const asked = answerDns({ "resend._domainkey.example.com|TXT": ["p=abc"] });
	const resend = await auditDomainDns("example.com", emptyView, "resend");
	assert.equal(resend.dkim.status, "ok");
	assert.ok(asked.includes("resend._domainkey.example.com"));
	const other = await auditDomainDns("example.com", emptyView, "none");
	assert.equal(other.dkim.status, "unknown");
});

test("the Resend receiving MX step accepts the published inbound-smtp record", async () => {
	stubResend([mxRecord("inbound-smtp.ap-northeast-1.amazonaws.com")]);
	answerDns({ "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] });
	assert.equal((await mxStep()).ok, true);
});

test("the Resend receiving MX step accepts any inbound-smtp record when Resend lists none", async () => {
	stubResend([]);
	answerDns({ "example.com|MX": ["10 inbound-smtp.ap-northeast-1.amazonaws.com."] });
	assert.equal((await mxStep()).ok, true);
	answerDns({ "example.com|MX": ["10 mail.other.net."] });
	assert.equal((await mxStep()).ok, false);
});

test("an MX record Resend verified needs no DNS re-check", async () => {
	stubResend([mxRecord("inbound-smtp.ap-northeast-1.amazonaws.com", "verified")]);
	answerDns({});
	assert.equal((await mxStep()).ok, true);
});

test("an unrelated MX still fails the Resend receiving MX step", async () => {
	stubResend([mxRecord("inbound-smtp.ap-northeast-1.amazonaws.com")]);
	answerDns({ "example.com|MX": ["10 mail.other.net."] });
	assert.equal((await mxStep()).ok, false);
});
