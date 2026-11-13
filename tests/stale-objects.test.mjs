import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-stale-objects-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/stale-objects.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { sweepStaleObjects } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function fakeBucket(objects, pageSize = 2) {
	const store = new Map(objects.map(([key, uploaded]) => [key, uploaded]));
	return {
		store,
		async list({ prefix, cursor, limit }) {
			// Like R2, the cursor is a position in key order, so deleting listed keys does not shift later pages.
			const keys = [...store.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
			const size = Math.min(limit, pageSize);
			const page = keys.slice(0, size);
			const truncated = keys.length > size;
			return { objects: page.map((key) => ({ key, uploaded: store.get(key) })), truncated, cursor: truncated ? page.at(-1) : undefined };
		},
		async delete(keys) {
			for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
		},
	};
}

test("only objects under the prefix and older than the cutoff are removed, across pages", async () => {
	const now = new Date("2026-01-10T00:00:00Z");
	const old = new Date("2026-01-01T00:00:00Z");
	const fresh = new Date("2026-01-09T23:59:00Z");
	const bucket = fakeBucket([
		["relay-seen/a", old],
		["relay-seen/b", fresh],
		["relay-seen/c", old],
		["relay-seen/d", old],
		["inbound/x", old],
	]);
	const removed = await sweepStaleObjects(bucket, "relay-seen/", 60 * 60 * 1000, now);
	assert.equal(removed, 3);
	assert.deepEqual([...bucket.store.keys()].sort(), ["inbound/x", "relay-seen/b"]);
});

test("one run looks at no more than five pages", async () => {
	const now = new Date("2026-01-10T00:00:00Z");
	const old = new Date("2026-01-01T00:00:00Z");
	const bucket = fakeBucket(Array.from({ length: 12 }, (_, index) => [`relay-seen/${String(index).padStart(2, "0")}`, old]), 2);
	assert.equal(await sweepStaleObjects(bucket, "relay-seen/", 60 * 60 * 1000, now), 10);
	assert.equal(bucket.store.size, 2);
});
