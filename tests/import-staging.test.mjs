import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-import-staging-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export * from "./src/lib/import/staging.ts"; export * from "./src/components/settings/import-jobs-utils.ts";`,
		resolveDir: root,
		sourcefile: "import-staging-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const { packImportMessages, unpackImportMessages, stageImportMessages, deleteStagedImport, importBatchKey, IMPORT_BATCH_SIZE, getImportJobPercent, isImportJobActive } =
	await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const encode = (text) => new TextEncoder().encode(text).buffer;
const decode = (buffer) => new TextDecoder().decode(buffer);

test("a packed batch unpacks to the same filenames and bytes", () => {
	const items = [
		{ filename: "a.eml", raw: encode("Subject: one\r\n\r\nbody") },
		{ filename: "inbox.mbox#2", raw: encode("") },
		{ filename: "ü.eml", raw: encode("héllo") },
	];
	const unpacked = unpackImportMessages(packImportMessages(items));
	assert.deepEqual(unpacked.map((item) => item.filename), items.map((item) => item.filename));
	assert.deepEqual(unpacked.map((item) => decode(item.raw)), ["Subject: one\r\n\r\nbody", "", "héllo"]);
});

test("unpacking works on a view into a larger buffer", () => {
	const packed = packImportMessages([{ filename: "x.eml", raw: encode("data") }]);
	const padded = new Uint8Array(packed.byteLength + 10);
	padded.set(packed, 7);
	const [item] = unpackImportMessages(padded.subarray(7, 7 + packed.byteLength));
	assert.equal(decode(item.raw), "data");
});

test("staging writes one object per batch and cleanup removes them", async () => {
	const objects = new Map();
	const env = {
		BUCKET: {
			put: async (key, value) => void objects.set(key, value),
			delete: async (key) => void objects.delete(key),
		},
	};
	const messages = Array.from({ length: IMPORT_BATCH_SIZE * 2 + 1 }, (_, index) => ({ filename: `${index}.eml`, raw: encode(`m${index}`) }));
	const batches = await stageImportMessages(env, "imp_1", messages);
	assert.equal(batches, 3);
	assert.deepEqual([...objects.keys()], [0, 1, 2].map((n) => importBatchKey("imp_1", n)));
	assert.equal(unpackImportMessages(objects.get(importBatchKey("imp_1", 2))).length, 1);
	await deleteStagedImport(env, "imp_1", batches);
	assert.equal(objects.size, 0);
});

test("a failed write removes the batches already staged", async () => {
	const objects = new Map();
	let writes = 0;
	const env = {
		BUCKET: {
			put: async (key, value) => {
				writes += 1;
				if (writes === 2) throw new Error("bucket down");
				objects.set(key, value);
			},
			delete: async (key) => void objects.delete(key),
		},
	};
	const messages = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, index) => ({ filename: `${index}.eml`, raw: encode("x") }));
	await assert.rejects(stageImportMessages(env, "imp_2", messages), /bucket down/);
	assert.equal(objects.size, 0);
});

test("progress is unknown until the job has a size, and capped at 100", () => {
	assert.equal(getImportJobPercent({ status: "running", total: 0, processed: 0 }), null);
	assert.equal(getImportJobPercent({ status: "running", total: 4, processed: 1 }), 25);
	assert.equal(getImportJobPercent({ status: "running", total: 4, processed: 9 }), 100);
	assert.equal(getImportJobPercent({ status: "completed", total: 0, processed: 0 }), 100);
	assert.equal(isImportJobActive({ status: "queued" }), true);
	assert.equal(isImportJobActive({ status: "failed" }), false);
});
