import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "message-list-cache-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(project, "src/hooks/utils.ts")],
	outfile: join(directory, "utils.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
	plugins: [{ name: "mock-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
			contents: `export const AUTH_SESSION_CHANGED_EVENT = "auth-changed"; export function getClientSessionToken(){return null;} export function authFetch(...args){return globalThis.listFetch(...args);}`,
			loader: "js",
		}));
	} }],
});
const utilsUrl = pathToFileURL(join(directory, "utils.mjs")).href;

async function setup() {
	const dom = new JSDOM("<!doctype html>");
	globalThis.window = dom.window;
	return { dom, utils: await import(`${utilsUrl}?run=${Math.random()}`) };
}
function cleanup(dom) {
	dom.window.close();
	delete globalThis.window;
	delete globalThis.listFetch;
}

test("an error response is rejected and not cached as a message list", async () => {
	const { dom, utils } = await setup();
	try {
		const params = new URLSearchParams("folder=inbox");
		globalThis.listFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "Mailbox not found" }) });
		await assert.rejects(utils.fetchMessageList(params), /Mailbox not found/);
		assert.equal(utils.peekMessageList(params), undefined);
		globalThis.listFetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }], total: 1 }) });
		assert.equal((await utils.fetchMessageList(params)).total, 1);
		assert.equal(utils.peekMessageList(params).total, 1);
	} finally { cleanup(dom); }
});
