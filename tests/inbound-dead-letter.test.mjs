import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-inbound-dead-letter-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { dead: join(root, "src/lib/email/dead-letter.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});

const { deadLetterInboundMail, DEAD_INBOUND_PREFIX } = await import(pathToFileURL(join(outDir, "dead.mjs")).href);

function bucket(initial) {
	const objects = new Map(Object.entries(initial));
	return {
		objects,
		async get(key) {
			const value = objects.get(key);
			return value ? { arrayBuffer: async () => value.body } : null;
		},
		async put(key, body, options) {
			objects.set(key, { body, options });
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}

const payload = { from: "a@example.com", to: "me@example.org", rawR2Key: "inbound/abc" };

test("raw mail moves out of inbound/ so the orphan sweep keeps it", async () => {
	const BUCKET = bucket({ "inbound/abc": { body: new TextEncoder().encode("raw").buffer } });
	const key = await deadLetterInboundMail({ BUCKET }, payload, new Error("D1 down"));
	assert.equal(key, `${DEAD_INBOUND_PREFIX}abc`);
	assert.ok(!BUCKET.objects.has("inbound/abc"));
	const moved = BUCKET.objects.get(key);
	assert.equal(new TextDecoder().decode(moved.body), "raw");
	assert.equal(moved.options.customMetadata.to, "me@example.org");
	assert.equal(moved.options.customMetadata.error, "D1 down");
});

test("a raw object that is already gone is not an error", async () => {
	const BUCKET = bucket({});
	assert.equal(await deadLetterInboundMail({ BUCKET }, payload, new Error("x")), null);
});

test("the original is kept when the copy fails", async () => {
	const BUCKET = bucket({ "inbound/abc": { body: new ArrayBuffer(1) } });
	BUCKET.put = async () => {
		throw new Error("R2 put failed");
	};
	await assert.rejects(deadLetterInboundMail({ BUCKET }, payload, new Error("x")));
	assert.ok(BUCKET.objects.has("inbound/abc"));
});
