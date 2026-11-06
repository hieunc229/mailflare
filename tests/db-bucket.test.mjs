import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Bundles stay under tests/ so their external imports (drizzle-orm, better-sqlite3) resolve
// against the repo's node_modules.
const outDir = mkdtempSync(join(root, "tests", ".tmp-db-bucket-"));

// The bucket resolves its database through withDatabase, which also reads process.env;
// clear the database variables so an exported DATABASE_URL cannot leak into these tests.
const savedEnv = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_DRIVER: process.env.DATABASE_DRIVER, DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN };
delete process.env.DATABASE_URL;
delete process.env.DATABASE_DRIVER;
delete process.env.DATABASE_AUTH_TOKEN;

after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(outDir, { recursive: true, force: true });
});

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") }, packages: "external" });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { DatabaseBucket } = await bundle("src/lib/storage/db-bucket.ts", "db-bucket.mjs");
const { withStorage } = await bundle("src/lib/storage/index.ts", "storage-index.mjs");
const { getStorageStatus, usesDatabaseStorage } = await bundle("src/lib/storage/b2-config.ts", "b2-config.mjs");

/** The sqlite migration this feature ships doubles as the schema the tests run against. */
const migration = readFileSync(join(root, "drizzle/migrations/0083_database_object_storage.sql"), "utf8")
	.split(/-->\s*statement-breakpoint/)
	.map((statement) => statement.trim())
	.filter(Boolean);

/** A minimal D1Database facade over better-sqlite3, matching the methods the bucket uses. */
function openD1() {
	const raw = new Database(":memory:");
	for (const statement of migration) raw.exec(statement);
	return {
		prepare(sql) {
			const statement = {
				sql,
				params: [],
				bind(...values) {
					statement.params = values;
					return statement;
				},
				all: async () => ({ results: raw.prepare(sql).all(...statement.params) }),
				first: async () => raw.prepare(sql).get(...statement.params) ?? null,
				run: async () => {
					raw.prepare(sql).run(...statement.params);
					return { success: true, results: [] };
				},
			};
			return statement;
		},
		batch: async (statements) => {
			raw.transaction(() => {
				for (const statement of statements) raw.prepare(statement.sql).run(...statement.params);
			})();
			return statements.map(() => ({ success: true, results: [] }));
		},
	};
}

test("put/get/head/delete round-trip with metadata", async () => {
	const bucket = new DatabaseBucket({ DB: openD1(), STORAGE_DRIVER: "database" });
	const put = await bucket.put("raw/hello.eml", "hello world", { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { note: "hi" } });
	assert.equal(put.size, 11);
	assert.equal(put.customMetadata.note, "hi");

	const got = await bucket.get("raw/hello.eml");
	assert.equal(await got.text(), "hello world");
	assert.equal(got.size, 11);
	assert.equal(got.httpMetadata.contentType, "message/rfc822");
	assert.equal(got.customMetadata.note, "hi");
	assert.ok(got.etag);
	assert.equal(got.httpEtag, `"${got.etag}"`);
	assert.equal(got.version, got.etag);
	assert.ok(got.uploaded instanceof Date);

	const head = await bucket.head("raw/hello.eml");
	assert.equal(head.size, 11);
	assert.equal(head.httpMetadata.contentType, "message/rfc822");

	// Replacing an object swaps its bytes and etag.
	await bucket.put("raw/hello.eml", "again");
	const replaced = await bucket.get("raw/hello.eml");
	assert.equal(await replaced.text(), "again");
	assert.notEqual(replaced.etag, got.etag);

	await bucket.put("raw/empty", null);
	assert.equal((await bucket.get("raw/empty")).size, 0);
	assert.equal(await (await bucket.get("raw/empty")).text(), "");

	assert.equal(await bucket.get("missing"), null);
	assert.equal(await bucket.head("missing"), null);
	await bucket.delete(["raw/hello.eml", "raw/empty", "never-existed"]);
	assert.equal(await bucket.get("raw/hello.eml"), null);
});

test("byte ranges read across chunk boundaries", async () => {
	const bucket = new DatabaseBucket({ DB: openD1() });
	// 2 full 768 KiB chunks plus a tail, so every boundary case is exercised.
	const body = new Uint8Array(2 * 768 * 1024 + 100);
	for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
	await bucket.put("big.bin", body);

	const whole = await bucket.get("big.bin");
	assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), body);

	const ranged = await bucket.get("big.bin", { range: { offset: 768 * 1024 - 10, length: 120 } });
	assert.equal(ranged.size, body.length);
	assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), body.subarray(768 * 1024 - 10, 768 * 1024 - 10 + 120));

	const suffix = await bucket.get("big.bin", { range: { suffix: 50 } });
	assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), body.subarray(body.length - 50));

	const streamed = await bucket.get("big.bin", { range: { offset: 100, length: 768 * 1024 } });
	const reader = streamed.body.getReader();
	const parts = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	assert.deepEqual(Buffer.concat(parts.map((part) => Buffer.from(part))), Buffer.from(body.subarray(100, 100 + 768 * 1024)));

	const outOfBounds = await bucket.get("big.bin", { range: { offset: body.length + 100 } });
	assert.equal((await outOfBounds.arrayBuffer()).byteLength, 0);
});

test("list honours prefix, order, cursor and hides staged parts", async () => {
	const bucket = new DatabaseBucket({ DB: openD1() });
	for (const key of ["b/1", "a/2", "a/1", "a/3"]) await bucket.put(key, key);
	const upload = await bucket.createMultipartUpload("a/uploading");
	await upload.uploadPart(1, "x");

	const all = await bucket.list();
	assert.deepEqual(all.objects.map((object) => object.key), ["a/1", "a/2", "a/3", "b/1"]);
	assert.equal(all.truncated, false);

	const prefixed = await bucket.list({ prefix: "a/" });
	assert.deepEqual(prefixed.objects.map((object) => object.key), ["a/1", "a/2", "a/3"]);

	const first = await bucket.list({ limit: 2 });
	assert.equal(first.truncated, true);
	const second = await bucket.list({ limit: 2, cursor: first.cursor });
	assert.deepEqual([...first.objects, ...second.objects].map((object) => object.key), ["a/1", "a/2", "a/3", "b/1"]);
	assert.equal(second.truncated, false);
	await upload.abort();
});

test("multipart uploads stage parts and rekey them on complete", async () => {
	const bucket = new DatabaseBucket({ DB: openD1() });
	const upload = await bucket.createMultipartUpload("drive/big", { httpMetadata: { contentType: "video/mp4" }, customMetadata: { name: "big.mp4" } });
	assert.equal(upload.key, "drive/big");
	const p1 = await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
	const p2 = await upload.uploadPart(2, new Uint8Array([4, 5]));
	assert.ok(p1.etag && p2.etag);

	// Resume statelessly and finish; part order in the argument does not matter.
	const done = await bucket.resumeMultipartUpload("drive/big", upload.uploadId).complete([p2, p1]);
	assert.equal(done.size, 5);
	assert.equal(done.httpMetadata.contentType, "video/mp4");
	assert.equal(done.customMetadata.name, "big.mp4");
	assert.deepEqual([...new Uint8Array(await (await bucket.get("drive/big")).arrayBuffer())], [1, 2, 3, 4, 5]);

	// Nothing is left behind under the staging prefix.
	const leftovers = await bucket.list({ prefix: "~db-multipart/" });
	assert.deepEqual(leftovers.objects, []);
	assert.equal(await bucket.get(`~db-multipart/${upload.uploadId}/1`), null);
});

test("multipart abort drops staged bytes and unknown uploads fail", async () => {
	const bucket = new DatabaseBucket({ DB: openD1() });
	const upload = await bucket.createMultipartUpload("drive/drop");
	await upload.uploadPart(1, "chunk");
	await upload.abort();
	await assert.rejects(bucket.resumeMultipartUpload("drive/drop", upload.uploadId).complete([]), /Unknown multipart upload/);
	await assert.rejects(bucket.resumeMultipartUpload("drive/drop", upload.uploadId).uploadPart(1, "x"), /Unknown multipart upload/);

	const resumed = await bucket.createMultipartUpload("drive/partial");
	await resumed.uploadPart(1, "a");
	await assert.rejects(resumed.complete([{ partNumber: 1, etag: "x" }, { partNumber: 2, etag: "y" }]), /part 2 is missing/);
});

test("withStorage: STORAGE_DRIVER=database wins, missing BUCKET falls back, others untouched", () => {
	const plain = { BUCKET: "r2", DB: "d1" };
	assert.equal(withStorage(plain), plain);
	assert.equal(usesDatabaseStorage({ STORAGE_DRIVER: " database " }), true);

	const explicit = withStorage({ BUCKET: "r2", DB: "d1", STORAGE_DRIVER: "database" });
	assert.equal(explicit.BUCKET.provider, "database");
	assert.equal(withStorage(explicit), explicit);

	const fallback = withStorage({ DB: "d1" });
	assert.equal(fallback.BUCKET.provider, "database");

	// The driver beats a configured S3 bucket; without it, S3 still wins over the fallback.
	const s3 = { BUCKET: "r2", DB: "d1", S3_BUCKET: "b", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" };
	assert.equal(withStorage({ ...s3, STORAGE_DRIVER: "database" }).BUCKET.provider, "database");
	assert.notEqual(withStorage(s3).BUCKET, "r2");
});

test("the bucket reaches the configured database, not the raw binding", async () => {
	// DATABASE_URL names an external database while env.DB is empty: the bucket must resolve
	// it lazily through withDatabase rather than reading the raw binding, because
	// withDatabase(withStorage(env)) wraps storage before the database swap runs.
	const file = join(outDir, "external.sqlite");
	const raw = new Database(file);
	for (const statement of migration) raw.exec(statement);
	raw.close();

	const env = { DATABASE_URL: `file:${file}`, DATABASE_DRIVER: "better-sqlite3", MAILFLARE_RUNTIME: "node" };
	const wrapped = withStorage({ ...env, STORAGE_DRIVER: "database" });
	const bucket = wrapped.BUCKET;
	assert.equal(bucket.provider, "database");
	assert.equal(env.DB, undefined);

	await bucket.put("mail/1.eml", "lazy");
	const got = await bucket.get("mail/1.eml");
	assert.equal(await got.text(), "lazy");

	const check = new Database(file);
	assert.equal(check.prepare("SELECT COUNT(*) AS n FROM storage_objects").get().n, 1);
	check.close();
});

test("getStorageStatus reports the database provider", () => {
	assert.equal(getStorageStatus({ STORAGE_DRIVER: "database" }).provider, "database");
	assert.equal(getStorageStatus({ BUCKET: "r2" }).provider, "r2");
	assert.equal(getStorageStatus({ BUCKET: "r2", MAILFLARE_RUNTIME: "node" }).provider, "files");
	const wrapped = withStorage({ DB: "d1" });
	assert.equal(getStorageStatus(wrapped).provider, "database");
});
