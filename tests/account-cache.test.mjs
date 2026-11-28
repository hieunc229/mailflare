import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { QueryClient } = await import("@tanstack/react-query");
const { loadManagedAccount, forgetManagedAccount } = await loadComponent("src/app/(admin)/accounts/[id]/account-cache.ts", {
	"./utils": "export async function fetchManagedAccount(id) { globalThis.__calls.push(id); return { id }; }",
});

const client = () => new QueryClient({ defaultOptions: { queries: { staleTime: 60000 } } });

test("second tab load is served from cache", async () => {
	globalThis.__calls = [];
	const c = client();
	await loadManagedAccount(c, "a1");
	await loadManagedAccount(c, "a1");
	assert.equal(globalThis.__calls.length, 1);
});

test("different accounts do not share", async () => {
	globalThis.__calls = [];
	const c = client();
	await loadManagedAccount(c, "a1");
	await loadManagedAccount(c, "a2");
	assert.equal(globalThis.__calls.length, 2);
});

test("forgetManagedAccount forces a refetch", async () => {
	globalThis.__calls = [];
	const c = client();
	await loadManagedAccount(c, "a1");
	forgetManagedAccount(c, "a1");
	await loadManagedAccount(c, "a1");
	assert.equal(globalThis.__calls.length, 2);
});
