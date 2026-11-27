import assert from "node:assert/strict";
import test from "node:test";
import relay from "../deploy/cloudflare-email-relay/src/index.ts";
import { verifyInboundSignatureV2 } from "../src/lib/email/intake-signature.ts";

const env = { MAILFLARE_URL: "https://mail.example.com/", INBOUND_WEBHOOK_SECRET: "secret" };

function message() {
	const calls = { rejected: [], forwarded: [] };
	return {
		calls,
		from: "sender@example.org",
		to: "user@example.com",
		rawSize: 64,
		raw: new Response("Subject: hi\r\n\r\nbody\r\n").body,
		headers: new Headers({ subject: "hi" }),
		setReject: (reason) => calls.rejected.push(reason),
		forward: async (to) => calls.forwarded.push(to),
	};
}

test("an unreachable server is a temporary failure, not a bounce", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
	const msg = message();
	await assert.rejects(relay.email(msg, env));
	assert.deepEqual(msg.calls.rejected, []);
});

test("a server error is a temporary failure, not a bounce", async (t) => {
	t.mock.method(console, "error", () => {});
	for (const status of [401, 409, 500, 502, 503]) {
		t.mock.method(globalThis, "fetch", async () => new Response("{}", { status }));
		const msg = message();
		await assert.rejects(relay.email(msg, env), new RegExp(String(status)));
		assert.deepEqual(msg.calls.rejected, [], `status ${status}`);
	}
});

test("an oversized message and a reject decision still bounce", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 413 }));
	const tooLarge = message();
	await relay.email(tooLarge, env);
	assert.equal(tooLarge.calls.rejected.length, 1);

	t.mock.method(globalThis, "fetch", async () => Response.json({ action: "reject", reason: "Blocked by rule" }));
	const ruled = message();
	await relay.email(ruled, env);
	assert.deepEqual(ruled.calls.rejected, ["Blocked by rule"]);
});

test("a stored message is accepted and forwarded when asked", async (t) => {
	t.mock.method(globalThis, "fetch", async (url) => {
		assert.equal(url, "https://mail.example.com/api/inbound");
		return Response.json({ action: "store", forwardTo: "copy@example.net" });
	});
	const msg = message();
	await relay.email(msg, env);
	assert.deepEqual(msg.calls.rejected, []);
	assert.deepEqual(msg.calls.forwarded, ["copy@example.net"]);
});

test("non-ASCII header values are sent as ASCII and still verify on the server", async (t) => {
	const decoded = { from: "Jürgen Öztürk <sender@example.org>", subject: "Çalışma planı 🎉" };
	let sent;
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		sent = { headers: new Headers(init.headers), body: init.body };
		return Response.json({ action: "store", forwardTo: null });
	});
	const msg = message();
	// Email Routing hands the Worker decoded header values; a Map stands in because
	// Node's Headers refuses characters above U+00FF.
	msg.headers = new Map(Object.entries(decoded));
	await relay.email(msg, env);

	const headerMap = sent.headers.get("x-mailflare-headers");
	assert.match(headerMap, /^[\x00-\x7e]*$/, "header map must be pure ASCII");
	assert.deepEqual(JSON.parse(headerMap), decoded);
	assert.equal(
		await verifyInboundSignatureV2(
			env.INBOUND_WEBHOOK_SECRET,
			sent.headers.get("x-mailflare-signature"),
			sent.body,
			sent.headers.get("x-mailflare-from"),
			sent.headers.get("x-mailflare-to"),
			headerMap,
			sent.headers.get("x-mailflare-timestamp"),
		),
		true,
	);
});
