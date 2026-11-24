import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-header-fallback-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Intake is replaced by a recorder, so the tests see exactly which header map reaches it.
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return {INBOUND_WEBHOOK_SECRET:'secret',BUCKET:{head:async()=>null,put:async()=>{}}}}",
	"@/lib/email/intake": "export async function intakeIncomingMail(env,input){globalThis.__intakeInput=input;return {action:'store'}}",
	"@/db": "export function getDb(){return {select:()=>({from:()=>({where:()=>({limit:async()=>[{id:'d1'}]})})})}}",
};
await build({
	stdin: {
		contents: `
			export * as route from "./src/app/api/inbound/route.ts";
			export { intakeProviderMail } from "./src/lib/email/provider-intake.ts";
			export { parseSesNotification } from "./src/lib/aws/ses-notification.ts";
			export { signInbound } from "./src/lib/email/intake-signature.ts";
		`,
		resolveDir: root,
		sourcefile: "header-fallback-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	packages: "external",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /^(next\/server|@\/lib\/cloudflare|@\/lib\/email\/intake|@\/db)$/ }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const message = "From: news@x.test\r\nTo: me@one.test\r\nSubject: Sale\r\nList-Unsubscribe: <https://x.test/u>\r\n\r\nBody\r\n";
const raw = () => new TextEncoder().encode(message).buffer;

async function relay(headerMap) {
	const body = raw();
	const headers = { "x-mailflare-from": "news@x.test", "x-mailflare-to": "me@one.test", "x-mailflare-signature": await m.signInbound("secret", body, "news@x.test", "me@one.test") };
	if (headerMap !== undefined) headers["x-mailflare-headers"] = headerMap;
	globalThis.__intakeInput = null;
	const response = await m.route.POST(new Request("https://mail.test/api/inbound", { method: "POST", headers, body }));
	assert.equal(response.status, 200);
	return globalThis.__intakeInput.headers;
}

test("relay with an empty or missing header map falls back to the message headers", async () => {
	assert.equal((await relay("{}"))["list-unsubscribe"], "<https://x.test/u>");
	assert.equal((await relay(undefined))["list-unsubscribe"], "<https://x.test/u>");
	assert.equal((await relay("not json"))["list-unsubscribe"], "<https://x.test/u>");
});

test("relay keeps a header map it was given", async () => {
	assert.deepEqual(await relay('{"subject":"Hi"}'), { subject: "Hi" });
});

const notification = (headers, truncated) => JSON.stringify({
	notificationType: "Received",
	mail: { source: "news@x.test", destination: ["me@one.test"], headers, ...(truncated ? { headersTruncated: true } : {}) },
	receipt: { recipients: ["me@one.test"], virusVerdict: { status: "PASS" }, action: { type: "S3", bucketName: "b", objectKey: "k" } },
});

test("SES headers are used as sent, but dropped when SES reports them truncated", () => {
	const partial = [{ name: "Subject", value: "Sale" }];
	assert.deepEqual(m.parseSesNotification(notification(partial, false)).headers, { subject: "Sale" });
	assert.equal(m.parseSesNotification(notification(partial, true)).headers, undefined);
});

test("a truncated SES notification takes its headers from the raw message", async () => {
	const parsed = m.parseSesNotification(notification([{ name: "Subject", value: "Sale" }], true));
	globalThis.__intakeInput = null;
	await m.intakeProviderMail({}, { from: parsed.from, recipients: parsed.recipients, raw: raw(), headers: parsed.headers, verdicts: parsed.verdicts });
	assert.equal(globalThis.__intakeInput.headers["list-unsubscribe"], "<https://x.test/u>");
});
