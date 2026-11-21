import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-upload-ids-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { storeUpload, readUpload, readBlob } = await bundle("src/lib/jmap/blobs.ts", "blobs.mjs");
const { decodeBlobId } = await bundle("src/lib/jmap/ids.ts", "ids.mjs");
const { openFileBucket } = await bundle("server/runtime/file-bucket.ts", "file-bucket.mjs");
const { B2Bucket } = await bundle("src/lib/storage/b2-bucket.ts", "b2-bucket.mjs");

function context(userId) {
	const bucketRoot = mkdtempSync(join(outDir, "blobs-"));
	return { accountId: userId, auth: { userId }, env: { BUCKET: openFileBucket(bucketRoot) } };
}

test("an upload is readable by the account that stored it", async () => {
	const ctx = context("u1");
	const stored = await storeUpload(ctx, new TextEncoder().encode("hello").buffer, "text/plain", "a.txt");
	const upload = await readUpload(ctx, decodeBlobId(stored.blobId).id);
	assert.equal(new TextDecoder().decode(upload.content), "hello");
	assert.equal(upload.name, "a.txt");
});

test("an upload id with dot segments cannot reach another key", async () => {
	const ctx = context("u1");
	await ctx.env.BUCKET.put("avatars/u2", "victim avatar");
	assert.equal(await readUpload(ctx, "../../avatars/u2"), null);
	assert.equal(await readBlob({ ...ctx, memo: { mailboxes: Promise.resolve([]) } }, "up~../../avatars/u2"), null);
});

test("FileBucket refuses keys with . or .. segments", async () => {
	const bucket = context("u1").env.BUCKET;
	await bucket.put("avatars/u2", "victim avatar");
	assert.equal(await bucket.get("jmap-uploads/u1/../../avatars/u2"), null);
	await assert.rejects(bucket.put("jmap-uploads/u1/../../avatars/u2", "x"));
	await assert.rejects(bucket.delete("jmap-uploads/u1/./../../avatars/u2"));
	assert.notEqual(await bucket.get("avatars/u2"), null);
});

test("B2Bucket refuses keys with . or .. segments before sending a request", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		calls.push(String(url));
		return new Response("", { status: 200 });
	});
	const bucket = new B2Bucket({ keyId: "k", applicationKey: "s", bucket: "b", endpoint: "s3.us-west-004.backblazeb2.com", region: "us-west-004" });
	await assert.rejects(bucket.get("jmap-uploads/u1/../../avatars/u2"));
	await assert.rejects(bucket.put("a/./b", "x"));
	assert.deepEqual(calls, []);
});
