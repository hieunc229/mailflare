import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-resend-compat-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The send path only needs the env it is given; the database is stubbed.
const mocks = {
	"@/db": "export function getDb(){throw new Error('no database in this test');}",
	"@/db/schema": "export const appSettings={};export const domains={};",
};

await build({
	entryPoints: [join(root, "src/lib/email/outbound-provider.ts")],
	outfile: join(outDir, "outbound-provider.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "mock-send-deps",
		setup(builder) {
			const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
			builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});
const { sendThroughProvider } = await import(pathToFileURL(join(outDir, "outbound-provider.mjs")).href);
await build({
	entryPoints: [join(root, "src/lib/email/resend-api.ts")],
	outfile: join(outDir, "resend-api.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const resendApi = await import(pathToFileURL(join(outDir, "resend-api.mjs")).href);

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// `reads` are the successive GET /emails/{id} bodies; the last one repeats.
function mockProvider(...reads) {
	const calls = [];
	let read = 0;
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url);
		calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
		if (init.method === "POST") return Response.json({ id: "email_1" });
		return Response.json({ id: "email_1", ...(reads[Math.min(read++, reads.length - 1)] ?? {}) });
	};
	return calls;
}
const sent = (messageId) => ({ message_id: messageId, last_event: "sent" });

const message = { from: "Me <me@example.com>", to: ["you@example.net"], subject: "Hi", text: "t", html: "<p>t</p>", headers: { "In-Reply-To": "<x@example.net>" } };
const send = (env = {}) => sendThroughProvider(env, { provider: "resend", apiKey: "re_test" }, message);

test("by default the Resend send goes to api.resend.com with our own Message-ID", async () => {
	const calls = mockProvider();
	const { messageId } = await send();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url.href, "https://api.resend.com/emails");
	assert.equal(calls[0].body.headers["Message-ID"], messageId);
	assert.equal(calls[0].body.headers["In-Reply-To"], "<x@example.net>");
	assert.match(messageId, /^<[^@]+@example\.com>$/);
});

test("RESEND_BASE_URL sends to a Resend-compatible API", async () => {
	const calls = mockProvider();
	await send({ RESEND_BASE_URL: "https://api.compatible.example/" });
	assert.equal(calls[0].url.href, "https://api.compatible.example/emails");
});

test("RESEND_CUSTOM_MESSAGE_ID=false omits the header and threads on the provider's Message-ID", async () => {
	const calls = mockProvider(sent("<0103abc@email.amazonses.com>"));
	const { messageId } = await send({ RESEND_BASE_URL: "https://api.compatible.example", RESEND_CUSTOM_MESSAGE_ID: "false" });
	assert.equal(calls[0].body.headers["Message-ID"], undefined);
	assert.equal(calls[0].body.headers["In-Reply-To"], "<x@example.net>");
	assert.equal(calls[1].url.href, "https://api.compatible.example/emails/email_1");
	assert.equal(messageId, "<0103abc@email.amazonses.com>");
});

test("without a provider Message-ID the minted one is kept", async () => {
	const env = { RESEND_CUSTOM_MESSAGE_ID: "false" };
	mockProvider();
	assert.match((await send(env)).messageId, /^<[^@]+@example\.com>$/);
	mockProvider(sent("not-a-message-id"));
	assert.match((await send(env)).messageId, /^<[^@]+@example\.com>$/);
});

test("a queued send's placeholder Message-ID is not used; the ID after it leaves the queue is", async () => {
	const { fetchSentMessageId } = resendApi;
	const client = { apiKey: "re_test", baseUrl: "https://api.compatible.example" };
	const noWait = { attempts: 3, delayMs: 0, sleep: async () => {} };
	mockProvider({ message_id: "<email_1@unsent.example>", last_event: "queued" }, sent("<0103real@email.amazonses.com>"));
	assert.equal(await fetchSentMessageId(client, "email_1", noWait), "<0103real@email.amazonses.com>");
	const calls = mockProvider({ message_id: "<email_1@unsent.example>", last_event: "queued" });
	assert.equal(await fetchSentMessageId(client, "email_1", noWait), null);
	assert.equal(calls.length, 3);
});

test("RESEND_OMIT_HEADERS leaves the listed headers out, matching names case-insensitively", async () => {
	const calls = mockProvider();
	const autoMessage = { ...message, headers: { ...message.headers, "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } };
	await sendThroughProvider({ RESEND_OMIT_HEADERS: " auto-submitted , " }, { provider: "resend", apiKey: "re_test" }, autoMessage);
	assert.equal(calls[0].body.headers["Auto-Submitted"], undefined);
	assert.equal(calls[0].body.headers["X-Auto-Response-Suppress"], "All");
	assert.equal(calls[0].body.headers["In-Reply-To"], "<x@example.net>");
});
