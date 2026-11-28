import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mailer-cloudflare-"));
const realFetch = globalThis.fetch;
after(() => { rmSync(outDir, { recursive: true, force: true }); globalThis.fetch = realFetch; });
await build({
	entryPoints: [join(root, "server/runtime/mailer.ts")],
	outfile: join(outDir, "mailer.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	plugins: [{
		name: "stubs",
		setup(builder) {
			const stubs = {
				nodemailer: "export default { createTransport() { return { sendMail: async () => ({}) }; } };",
				"@/lib/utils": "export function parseAddress(address) { const value = String(address).trim(); const match = value.match(/^([^@\\s]+)@([^@\\s]+)$/); return match ? { local: match[1], domain: match[2] } : null; }",
			};
			builder.onResolve({ filter: /.*/ }, ({ path }) => (path in stubs ? { path, namespace: "stub" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({ contents: stubs[path], loader: "js" }));
		},
	}],
});
const { Mailer } = await import(pathToFileURL(join(outDir, "mailer.mjs")).href);

const mailer = () => new Mailer({ kind: "cloudflare", accountId: "acc123", token: "tok" });
const message = (headers = {}) => ({
	from: "me@example.com",
	to: "you@example.com",
	subject: "Hello",
	text: "Hi",
	headers: {
		"In-Reply-To": "<parent@example.com>",
		"References": "<parent@example.com>",
		...headers,
	},
});
const reply = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);
const headerKeys = (headers) => Object.keys(headers ?? {});
const hasMessageId = (headers) => headerKeys(headers).some((key) => key.toLowerCase() === "message-id");

test("Cloudflare send omits Message-ID and keeps threading headers", async () => {
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) };
		return reply({ success: true, result: { message_id: "<cf-assigned@cloudflare.com>" } });
	};
	const result = await mailer().send(message({ "Message-ID": "<local@example.com>" }));
	assert.equal(request.method, "POST");
	assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
	assert.equal(request.headers.Authorization, "Bearer tok");
	assert.equal(hasMessageId(request.body.headers), false);
	assert.equal(request.body.headers["In-Reply-To"], "<parent@example.com>");
	assert.equal(request.body.headers["References"], "<parent@example.com>");
	assert.equal(result.messageId, "<cf-assigned@cloudflare.com>");
});

test("Cloudflare send strips Message-ID regardless of header case", async () => {
	let request;
	globalThis.fetch = async (_url, init) => {
		request = { body: JSON.parse(init.body) };
		return reply({ success: true, result: { message_id: "<cf-assigned@cloudflare.com>" } });
	};
	await mailer().send(message({ "message-id": "<lower@example.com>" }));
	assert.equal(hasMessageId(request.body.headers), false);
	assert.equal(request.body.headers["In-Reply-To"], "<parent@example.com>");
});

test("Cloudflare send falls back to messageId then the local id", async () => {
	globalThis.fetch = async () => reply({ success: true, result: { messageId: "<camel@cloudflare.com>" } });
	const camel = await mailer().send(message());
	assert.equal(camel.messageId, "<camel@cloudflare.com>");

	globalThis.fetch = async () => reply({ success: true, result: {} });
	const fallback = await mailer().send(message({ "Message-ID": "<local@example.com>" }));
	assert.equal(fallback.messageId, "<local@example.com>");
});

test("a 400/10202 Cloudflare response still throws the existing error shape", async () => {
	const detail = JSON.stringify({ success: false, errors: [{ code: 10202, message: "email.sending.error.email.invalid" }], messages: [], result: null });
	globalThis.fetch = async () => reply(detail, { status: 400, statusText: "Bad Request" });
	await assert.rejects(
		mailer().send(message({ "Message-ID": "<local@example.com>" })),
		(error) => error instanceof Error
			&& error.message.startsWith("Cloudflare Email Sending failed (400):")
			&& error.message.includes("10202")
			&& error.message.includes("email.sending.error.email.invalid"),
	);
});
