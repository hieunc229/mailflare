import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

test("a failed mailbox list is rejected and not cached", async () => {
	const { fetchMailboxOptions } = await loadComponent("src/components/mailbox-provider-utils.ts", {
		"@/lib/auth/client": "export const getClientSessionToken = () => 't'; export async function authFetch() { globalThis.__calls++; return globalThis.__next(); }",
	});
	globalThis.__calls = 0;
	globalThis.__next = () => new Response(JSON.stringify({ error: "x" }), { status: 500 });
	await assert.rejects(fetchMailboxOptions());
	globalThis.__next = () => Response.json({ mailboxes: [{ id: "m1", userId: "u", domainId: "d", localPart: "a", hostname: "x.test" }] });
	const items = await fetchMailboxOptions();
	assert.equal(items.length, 1);
	assert.equal(items[0].id, "m1");
	const calls = globalThis.__calls;
	await fetchMailboxOptions();
	assert.equal(globalThis.__calls, calls, "a successful list is cached");
});
