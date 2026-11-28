import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

test("fetchInboxRules rejects on a non-OK response and resolves the rules otherwise", async () => {
	const { fetchInboxRules } = await loadComponent("src/components/settings/inbox-rules-utils.ts", {
		"@/lib/auth/client": `export async function authFetch() { return globalThis.__response; }`,
		"@/lib/folders/client": `export async function getMailboxFolders() { return {}; }`,
	});
	globalThis.__response = new Response(JSON.stringify({ error: "boom" }), { status: 500 });
	await assert.rejects(fetchInboxRules("m1"));
	globalThis.__response = new Response(JSON.stringify({ rules: [] }), { status: 200 });
	assert.deepEqual(await fetchInboxRules("m1"), { rules: [] });
});

test("settings lists show a retry state instead of the empty text", () => {
	for (const file of ["inbox-rules.tsx", "domain-routing/domain-routing.tsx"]) {
		const source = readFileSync(`src/components/settings/${file}`, "utf8");
		assert.ok(source.includes("rules.isError"), `${file}: isError`);
		assert.ok(source.includes('role="alert"') && source.includes("webhooks.retry") && source.includes("list.loadFailed"), `${file}: alert and Retry`);
	}
	const keys = readFileSync("src/components/settings/api-keys-settings.tsx", "utf8");
	const none = keys.split("\n").find((line) => line.includes("apiKeys.none"));
	assert.ok(none.includes("!loadError &&"), "the none text waits for a clean load");
	assert.ok(keys.includes("webhooks.retry"));
});
