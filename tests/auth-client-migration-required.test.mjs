import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "auth-client-migration-"));
const output = join(directory, "client.mjs");
await build({
	entryPoints: [process.env.MF36_CLIENT_SOURCE ?? join(project, "src/lib/auth/client.ts")],
	outfile: output,
	bundle: true,
	platform: "node",
	format: "esm",
	plugins: [{
		name: "time-stubs",
		setup(builder) {
			builder.onResolve({ filter: /^@\/lib\/time\// }, ({ path }) => ({ path, namespace: "stub" }));
			builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
				export const getUserTimeZone = () => "UTC";
				export const clearUserTimeZonePreference = () => {};
			` }));
		},
	}],
});
const original = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, CustomEvent: globalThis.CustomEvent };
after(() => {
	Object.assign(globalThis, original);
	rmSync(directory, { recursive: true, force: true });
});
let sequence = 0;
async function setup(pathname = "/inbox") {
	const navigations = [];
	const storage = new Map([["mailflare-session-token", "still-valid"]]);
	globalThis.window = { location: { pathname, assign: (path) => navigations.push(path) }, dispatchEvent() {} };
	globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, removeItem: (key) => storage.delete(key) };
	globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
	const client = await import(`${pathToFileURL(output).href}?case=${sequence++}`);
	return { ...client, navigations, storage };
}

test("bodyless 409 navigates once to a visible, script-free migration explanation", async () => {
	const { authFetch, navigations, storage } = await setup();
	globalThis.fetch = async () => new Response(null, { status: 409 });
	await Promise.all(Array.from({ length: 10 }, () => authFetch("/api/mailboxes")));
	assert.deepEqual(navigations, ["/migration-required.html"]);
	assert.equal(storage.get("mailflare-session-token"), "still-valid");
	const dom = new JSDOM(readFileSync(join(project, "public", navigations[0]), "utf8"));
	assert.equal(dom.window.document.querySelector("h1").textContent, "This deployment needs database migrations");
	assert.match(dom.window.document.body.textContent, /deployment administrator/);
	assert.equal(dom.window.document.querySelectorAll("script, meta[http-equiv='refresh']").length, 0);
	assert.equal(dom.window.document.querySelector("a").getAttribute("href"), "/inbox");
	dom.window.close();
});

test("empty stream bodies also dedupe after asynchronous inspection", async () => {
	const { authFetch, navigations } = await setup();
	globalThis.fetch = async () => new Response("", { status: 409, headers: { "content-type": "application/json" } });
	await Promise.all(Array.from({ length: 5 }, () => authFetch("/api/messages/counts")));
	assert.deepEqual(navigations, ["/migration-required.html"]);
});

for (const code of ["MX_CONFLICT", "MIGRATION_REQUIRED"]) {
	test(`JSON 409 ${code} passes through unchanged, without navigating`, async () => {
		const { authFetch, navigations } = await setup();
		const response = Response.json({ code, error: "Existing caller message" }, { status: 409 });
		globalThis.fetch = async () => response;
		const result = await authFetch("/api/domains");
		assert.equal(result, response);
		assert.equal(result.bodyUsed, false);
		assert.deepEqual(await result.json(), { code, error: "Existing caller message" });
		assert.deepEqual(navigations, []);
	});
}

test("headers cannot misclassify nonempty conflicts as bodyless", async () => {
	const { authFetch, navigations } = await setup();
	for (const body of ['{"code":"MX_CONFLICT"}', "Conflict", " "]) {
		const response = new Response(body, { status: 409, headers: { "content-length": "0" } });
		globalThis.fetch = async () => response;
		assert.equal(await (await authFetch("/api/domains")).text(), body);
	}
	assert.deepEqual(navigations, []);
});

test("unreadable 409 is not assumed to be empty", async () => {
	const { authFetch, navigations } = await setup();
	const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken stream")); } }), { status: 409 });
	globalThis.fetch = async () => response;
	assert.equal(await authFetch("/api/mailboxes"), response);
	assert.deepEqual(navigations, []);
});

for (const path of ["/migration-required.html", "/migration-required"]) {
	test(`no redirect when already on ${path}`, async () => {
		const { authFetch, navigations } = await setup(path);
		globalThis.fetch = async () => new Response(null, { status: 409 });
		await authFetch("/api/auth/me");
		assert.deepEqual(navigations, []);
	});
}

test("401 still clears the session and redirects, opt-out still preserves it", async () => {
	const { authFetch, navigations, storage } = await setup();
	globalThis.fetch = async () => new Response(null, { status: 401 });
	await authFetch("/api/auth/me", { redirectOnUnauthorized: false });
	assert.equal(storage.get("mailflare-session-token"), "still-valid");
	assert.deepEqual(navigations, []);
	await authFetch("/api/auth/me");
	assert.equal(storage.has("mailflare-session-token"), false);
	assert.deepEqual(navigations, ["/login"]);
});

test("other empty statuses and server-side 409 do not navigate", async () => {
	const { authFetch, navigations } = await setup();
	for (const status of [200, 403, 500]) {
		globalThis.fetch = async () => new Response(null, { status });
		assert.equal((await authFetch("/api/auth/me")).status, status);
	}
	delete globalThis.window;
	globalThis.fetch = async () => new Response(null, { status: 409 });
	assert.equal((await authFetch("/api/auth/me")).status, 409);
	assert.deepEqual(navigations, []);
});
