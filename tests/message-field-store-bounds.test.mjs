import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(root, "node_modules", "mailflare-field-store-"));
after(() => rmSync(temp, { recursive: true, force: true }));

// The store listens on window for an account switch; a bare EventTarget stands in for it.
globalThis.window = new EventTarget();
await build({
	entryPoints: [join(root, "src/lib/messages/field-store.ts")],
	outfile: join(temp, "field-store.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "auth-stub",
		setup(b) {
			b.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth-client", namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";', loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const store = await import(pathToFileURL(join(temp, "field-store.mjs")).href);

test("known message fields stay bounded", () => {
	store.clearKnownMessageFieldsForTests();
	const ids = Array.from({ length: 5001 }, (_, index) => `m${index}`);
	for (const id of ids) store.rememberMessageFields([id], { read: true });
	assert.deepEqual(store.getVisibleMessageFields("m0"), {});
	assert.deepEqual(store.getVisibleMessageFields("m5000"), { read: true });
	assert.deepEqual(store.getVisibleMessageFields("m1"), { read: true });
});

test("an account switch clears the remembered fields", () => {
	store.clearKnownMessageFieldsForTests();
	store.rememberMessageFields(["a"], { starred: true });
	assert.deepEqual(store.getVisibleMessageFields("a"), { starred: true });
	window.dispatchEvent(new Event("mailflare:auth-session-changed"));
	assert.deepEqual(store.getVisibleMessageFields("a"), {});
});
