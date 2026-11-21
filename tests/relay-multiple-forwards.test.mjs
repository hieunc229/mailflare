import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import relay from "../deploy/cloudflare-email-relay/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-relay-forwards-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Intake asks for two forwards, like a keep-copy forward rule followed by account forwarding.
const mocks = {
	"@/lib/cloudflare": `export function getEnv() { return { INBOUND_WEBHOOK_SECRET: "secret" }; }`,
	"@/lib/email/intake": `export async function intakeIncomingMail(env, input, actions) {
		const marker = { "X-Mailflare-Forwarded": "v1.marker" };
		await actions.forward("team@elsewhere.test", marker);
		await actions.forward("archive@elsewhere.test", marker);
		return { action: "store", rawR2Key: "k", forwardedTo: "team@elsewhere.test" };
	}`,
	"@/lib/email/intake-signature": "export async function verifyInboundSignature() { return true; } export const verifyInboundSignatureV2 = verifyInboundSignature;",
	"@/lib/email/inbound-attachments": "export async function inboundAttachmentLimitReasonFromRaw() { return null; }",
};
await build({
	entryPoints: [join(root, "src/app/api/inbound/route.ts")],
	outfile: join(directory, "route.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	alias: { "next/server": "next/server.js" },
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => (path in mocks ? { path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
});
const { POST } = await import(pathToFileURL(join(directory, "route.mjs")).href);

const env = { MAILFLARE_URL: "https://mail.example.com", INBOUND_WEBHOOK_SECRET: "secret" };

function message() {
	const forwarded = [];
	return {
		forwarded,
		from: "sender@example.org",
		to: "me@one.test",
		rawSize: 64,
		raw: new Response("Subject: hi\r\n\r\nbody\r\n").body,
		headers: new Headers({ subject: "hi" }),
		setReject: () => assert.fail("relay rejected the message"),
		forward: async (to, headers) => { forwarded.push([to, headers.get("x-mailflare-forwarded")]); },
	};
}

test("/api/inbound lists every forward intake asked for", async () => {
	const response = await POST(new Request("https://mail.example.com/api/inbound", {
		method: "POST",
		headers: { "X-Mailflare-From": "sender@example.org", "X-Mailflare-To": "me@one.test", "X-Mailflare-Signature": "s" },
		body: "Subject: hi\r\n\r\nbody\r\n",
	}));
	const decision = await response.json();
	assert.deepEqual(decision.forwardToAll, ["team@elsewhere.test", "archive@elsewhere.test"]);
	// Relays deployed before forwardToAll keep getting the same forwardTo as before.
	assert.equal(decision.forwardTo, "archive@elsewhere.test");
	assert.deepEqual(decision.forwardHeaders, { "X-Mailflare-Forwarded": "v1.marker" });
});

test("the relay forwards to every destination, and one failure does not stop the next", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.method(globalThis, "fetch", async () => Response.json({
		action: "store",
		forwardTo: "archive@elsewhere.test",
		forwardToAll: ["team@elsewhere.test", "archive@elsewhere.test"],
		forwardHeaders: { "X-Mailflare-Forwarded": "v1.marker" },
	}));
	const msg = message();
	const forward = msg.forward;
	msg.forward = async (to, headers) => {
		await forward(to, headers);
		if (to === "team@elsewhere.test") throw new Error("destination not verified");
	};
	await relay.email(msg, env);
	assert.deepEqual(msg.forwarded, [["team@elsewhere.test", "v1.marker"], ["archive@elsewhere.test", "v1.marker"]]);
});

test("the relay still forwards to forwardTo from a server without forwardToAll", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ action: "store", forwardTo: "copy@example.net" }));
	const msg = message();
	await relay.email(msg, env);
	assert.deepEqual(msg.forwarded, [["copy@example.net", null]]);
});
