import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "folder-delete-client-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(project, "src/lib/folders/client.ts")],
	outfile: join(directory, "client.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
	plugins: [{ name: "mock-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
			contents: `export const AUTH_SESSION_CHANGED_EVENT = "auth-changed"; export function getClientSessionToken(){return "t";} export function authFetch(...args){return globalThis.folderFetch(...args);}`,
			loader: "js",
		}));
	} }],
});
const client = await import(pathToFileURL(join(directory, "client.mjs")).href);

function withWindow(run) {
	const dom = new JSDOM("<!doctype html>");
	globalThis.window = dom.window;
	globalThis.Event = dom.window.Event;
	return run().finally(() => { dom.window.close(); delete globalThis.window; delete globalThis.Event; delete globalThis.folderFetch; });
}

test("deleteFolder sends DELETE with the ids in the query and tells the app folders and messages changed", () => withWindow(async () => {
	const calls = [];
	globalThis.folderFetch = async (url, options) => { calls.push([url, options.method]); return { ok: true, json: async () => ({ ok: true, moved: 2 }) }; };
	const events = [];
	for (const name of ["mailflare:folders-changed", "mailflare:messages-changed"]) window.addEventListener(name, () => events.push(name));
	assert.deepEqual(await client.deleteFolder("mb 1", "fld/1"), { ok: true });
	assert.deepEqual(calls, [["/api/folders?id=fld%2F1&mailboxId=mb+1", "DELETE"]]);
	assert.deepEqual(events.sort(), ["mailflare:folders-changed", "mailflare:messages-changed"]);
}));

test("deleteFolder returns the server's reason and fires no events when refused", () => withWindow(async () => {
	globalThis.folderFetch = async () => ({ ok: false, json: async () => ({ error: "Inbox rules still file into this folder: A." }) });
	const events = [];
	window.addEventListener("mailflare:folders-changed", () => events.push("x"));
	assert.deepEqual(await client.deleteFolder("mb1", "f1"), { ok: false, error: "Inbox rules still file into this folder: A." });
	globalThis.folderFetch = async () => ({ ok: false, json: async () => { throw new Error("not json"); } });
	assert.deepEqual(await client.deleteFolder("mb1", "f1"), { ok: false });
	assert.deepEqual(events, []);
}));
