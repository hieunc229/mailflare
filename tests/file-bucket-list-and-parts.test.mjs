import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-file-bucket-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "server/runtime/file-bucket.ts")], outfile: join(outDir, "bucket.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
const { openFileBucket } = await import(pathToFileURL(join(outDir, "bucket.mjs")).href);

const newBucket = () => {
	const dir = mkdtempSync(join(outDir, "root-"));
	return { dir, bucket: openFileBucket(dir) };
};

test("uploadPart writes only the bytes of a view", async () => {
	const { dir, bucket } = newBucket();
	const pool = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const upload = await bucket.createMultipartUpload("big.bin");
	const part = await upload.uploadPart(1, new Uint8Array(pool.buffer, 2, 3));
	await upload.complete([part]);
	assert.deepEqual([...readFileSync(join(dir, "big.bin"))], [2, 3, 4]);
});

async function seeded() {
	const { dir, bucket } = newBucket();
	for (const key of ["z", "a/c/d", "a/b", "a.txt"]) await bucket.put(key, "x");
	mkdirSync(join(dir, ".multipart", "x"), { recursive: true });
	writeFileSync(join(dir, ".multipart", "x", "part-1"), "p");
	return bucket;
}

test("list returns keys in string order and hides multipart parts", async () => {
	const bucket = await seeded();
	const page = await bucket.list({ limit: 10 });
	assert.deepEqual(page.objects.map((o) => o.key), ["a.txt", "a/b", "a/c/d", "z"]);
	assert.equal(page.truncated, false);
});

test("list pages by cursor", async () => {
	const bucket = await seeded();
	const first = await bucket.list({ limit: 2 });
	assert.deepEqual(first.objects.map((o) => o.key), ["a.txt", "a/b"]);
	assert.equal(first.truncated, true);
	assert.equal(first.cursor, "a/b");
	const second = await bucket.list({ limit: 2, cursor: first.cursor });
	assert.deepEqual(second.objects.map((o) => o.key), ["a/c/d", "z"]);
	assert.equal(second.truncated, false);
});

test("list honours a prefix that names a directory", async () => {
	const bucket = await seeded();
	const page = await bucket.list({ prefix: "a/" });
	assert.deepEqual(page.objects.map((o) => o.key), ["a/b", "a/c/d"]);
});
