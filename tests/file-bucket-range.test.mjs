import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-file-bucket-range-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "server/runtime/file-bucket.ts")],
	outfile: join(outDir, "file-bucket.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
const { openFileBucket } = await import(pathToFileURL(join(outDir, "file-bucket.mjs")).href);

function bucketWith(content) {
	const bucket = openFileBucket(mkdtempSync(join(outDir, "bucket-")));
	writeFileSync(join(outDir, "source.bin"), content);
	return bucket.put("object.bin", content).then(() => bucket);
}

test("a ranged read returns only the requested bytes", async () => {
	const content = Buffer.alloc(64 * 1024);
	for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
	const bucket = await bucketWith(content);

	const object = await bucket.get("object.bin", { range: { offset: 1000, length: 2048 } });
	const bytes = new Uint8Array(await object.arrayBuffer());
	assert.equal(bytes.byteLength, 2048, "a bounded read, not the whole file");
	assert.deepEqual(bytes, new Uint8Array(content.subarray(1000, 1000 + 2048)));

	// The stream body honours the same range.
	const streamed = Buffer.from(await new Response(object.body).arrayBuffer());
	assert.equal(streamed.byteLength, 2048);
	assert.deepEqual(new Uint8Array(streamed), bytes);
});

test("a range past the end is clamped and a zero-length range is empty", async () => {
	const content = Buffer.from("0123456789");
	const bucket = await bucketWith(content);

	const tail = await bucket.get("object.bin", { range: { offset: 7, length: 100 } });
	assert.equal(new TextDecoder().decode(await tail.arrayBuffer()), "789");

	const empty = await bucket.get("object.bin", { range: { offset: 0, length: 0 } });
	assert.equal((await empty.arrayBuffer()).byteLength, 0);
	assert.equal((await new Response(empty.body).arrayBuffer()).byteLength, 0, "an empty range is not read to the end of the file");
});

test("a suffix range returns the last bytes", async () => {
	const content = Buffer.from("abcdefghij");
	const bucket = await bucketWith(content);
	const object = await bucket.get("object.bin", { range: { suffix: 3 } });
	assert.equal(new TextDecoder().decode(await object.arrayBuffer()), "hij");
});

test("a zero-byte object reads as empty in either mode", async () => {
	const bucket = await bucketWith(Buffer.alloc(0));
	assert.equal((await bucket.get("object.bin")).size, 0);
	const ranged = await bucket.get("object.bin", { range: { offset: 0, length: 1024 } });
	assert.equal((await ranged.arrayBuffer()).byteLength, 0);
	assert.equal((await new Response(ranged.body).arrayBuffer()).byteLength, 0);
});

test("an object without a range still reads whole", async () => {
	const content = Buffer.from("whole object");
	const bucket = await bucketWith(content);
	assert.equal(new TextDecoder().decode(await (await bucket.get("object.bin")).arrayBuffer()), "whole object");
});
