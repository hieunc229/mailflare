import assert from "node:assert/strict";
import test from "node:test";
import relay from "../deploy/cloudflare-email-relay/src/index.ts";

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
