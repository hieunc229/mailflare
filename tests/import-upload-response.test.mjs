import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "import-upload-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	entryPoints: [join(project, "src/components/settings/import-messages-utils.ts")],
	outfile: join(directory, "utils.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
	plugins: [{ name: "mock-auth", setup(builder) {
		builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `export function getAuthHeaders(){return new Headers();}`, loader: "js" }));
	} }],
});
const utils = await import(pathToFileURL(join(directory, "utils.mjs")).href);

function stubXhr(finish) {
	globalThis.FormData = class { set() {} append() {} };
	globalThis.XMLHttpRequest = class {
		upload = {};
		open() {}
		setRequestHeader() {}
		send() { queueMicrotask(() => finish(this)); }
	};
}

test("a non-JSON error page rejects instead of hanging", async () => {
	stubXhr((x) => { x.status = 502; x.responseText = "<html>Bad gateway</html>"; x.onload(); });
	await assert.rejects(utils.importMessageFiles("mb", [], "inbox"), /Import failed/);
});

test("abort and timeout reject", async () => {
	stubXhr((x) => x.onabort());
	await assert.rejects(utils.importMessageFiles("mb", [], "inbox"), /cancelled/);
	stubXhr((x) => x.ontimeout());
	await assert.rejects(utils.importMessageFiles("mb", [], "inbox"), /timed out/);
});

test("a JSON success still resolves", async () => {
	stubXhr((x) => { x.status = 202; x.responseText = JSON.stringify({ job: { id: "j1" } }); x.onload(); });
	assert.deepEqual(await utils.importMessageFiles("mb", [], "inbox"), { job: { id: "j1" } });
});
