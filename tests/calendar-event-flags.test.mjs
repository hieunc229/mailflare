import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-event-flags-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: { flags: join(root, "src/lib/calendar/event-flags.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { resolveEventFlags } = await import(pathToFileURL(join(dir, "flags.mjs")).href);

test("the API keeps a flag the request omits and accepts only booleans", () => {
	assert.deepEqual(resolveEventFlags(null, {}), { isPrivate: false, transparent: false });
	assert.deepEqual(resolveEventFlags(null, { isPrivate: true, transparent: true }), { isPrivate: true, transparent: true });
	assert.deepEqual(resolveEventFlags({ isPrivate: true, transparent: false }, {}), { isPrivate: true, transparent: false });
	assert.deepEqual(resolveEventFlags({ isPrivate: true, transparent: false }, { isPrivate: false, transparent: true }), { isPrivate: false, transparent: true });
	assert.deepEqual(resolveEventFlags({ isPrivate: true, transparent: true }, { isPrivate: "no", transparent: 0 }), { isPrivate: true, transparent: true });
});
