import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-s3-endpoint-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { getS3Config } = await bundle("src/lib/storage/b2-config.ts", "config.mjs");
const { B2Bucket, presignPutUrl } = await bundle("src/lib/storage/b2-bucket.ts", "bucket.mjs");
const { signAwsRequest, presignS3Url } = await bundle("src/lib/aws/sigv4.ts", "sigv4.mjs");

const NOW = new Date("2026-01-02T03:04:05Z");
const creds = { accessKeyId: "AKTEST", secretAccessKey: "secret" };
const base = { S3_ACCESS_KEY_ID: "AKTEST", S3_SECRET_ACCESS_KEY: "secret", S3_BUCKET: "mailbox" };

const aws = getS3Config({ ...base, S3_REGION: "eu-west-1" });
const virtual = getS3Config({ ...base, S3_REGION: "fsn1", S3_ENDPOINT: "fsn1.your-objectstorage.com" });
const path = getS3Config({ ...base, S3_REGION: "fsn1", S3_ENDPOINT: "fsn1.your-objectstorage.com", S3_FORCE_PATH_STYLE: "true" });
const local = getS3Config({ ...base, S3_REGION: "us-east-1", S3_ENDPOINT: "http://localhost:9000", MAILFLARE_RUNTIME: "node" });

/** Runs `run` with fetch stubbed and the clock fixed; returns every request made. */
async function capture(run, respond = () => new Response("<UploadId>u1</UploadId>", { status: 200, headers: { etag: '"e1"' } })) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		calls.push({ url: new URL(String(input)), init, method: init.method ?? "GET", headers: init.headers ?? {} });
		return respond(calls.at(-1));
	};
	mock.timers.enable({ apis: ["Date"], now: NOW });
	try { await run(); } finally { mock.timers.reset(); globalThis.fetch = original; }
	return calls;
}

const scope = (region) => `Credential=AKTEST/20260102/${region}/s3/aws4_request`;

// --- AWS behaviour, unchanged -------------------------------------------------------------------------------

test("characterization: AWS S3 is addressed virtual-hosted on the regional host", async () => {
	const calls = await capture(async () => {
		const bucket = new B2Bucket(aws);
		await bucket.get("a/b c.txt");
		await bucket.put("a/b c.txt", "hi");
		await bucket.list({ prefix: "a/" });
	});
	assert.equal(calls[0].url.href, "https://mailbox.s3.eu-west-1.amazonaws.com/a/b%20c.txt");
	assert.equal(calls[1].method, "PUT");
	assert.equal(calls[2].url.origin + calls[2].url.pathname, "https://mailbox.s3.eu-west-1.amazonaws.com/");
	assert.match(calls[0].headers.Authorization, new RegExp(scope("eu-west-1")));
	assert.equal(calls[0].headers.host, "mailbox.s3.eu-west-1.amazonaws.com");
	assert.equal(calls[0].init.redirect, undefined);
});

test("characterization: AWS presigned PUT", async () => {
	const url = new URL(await presignPutUrl(aws, "request-uploads/u1/x", 5, 900));
	assert.equal(url.origin + url.pathname, "https://mailbox.s3.eu-west-1.amazonaws.com/request-uploads/u1/x");
	assert.equal(url.searchParams.get("X-Amz-Credential")?.startsWith("AKTEST/"), true);
	assert.equal(url.searchParams.get("X-Amz-Credential")?.split("/")[2], "eu-west-1");
	assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
});

// --- S3-compatible: both addressing styles --------------------------------------------------------------------

for (const [label, config, host, prefix] of [
	["virtual-hosted", virtual, "mailbox.fsn1.your-objectstorage.com", ""],
	["path style", path, "fsn1.your-objectstorage.com", "/mailbox"],
]) {
	test(`${label}: get, head, put, delete, list`, async () => {
		const calls = await capture(async () => {
			const bucket = new B2Bucket(config);
			await bucket.get("a/b c+d.txt");
			await bucket.head("a/b c+d.txt");
			await bucket.put("a/b c+d.txt", "hi");
			await bucket.delete("a/b c+d.txt");
			await bucket.list({ prefix: "a/" });
		});
		const key = `${prefix}/a/b%20c%2Bd.txt`;
		assert.deepEqual(calls.slice(0, 4).map((c) => [c.method, c.url.host, c.url.pathname]), [
			["GET", host, key], ["HEAD", host, key], ["PUT", host, key], ["DELETE", host, key],
		]);
		assert.equal(calls[4].url.host, host);
		assert.equal(calls[4].url.pathname, prefix || "/");
		assert.equal(calls[4].url.searchParams.get("list-type"), "2");
		for (const call of calls) {
			assert.equal(call.url.protocol, "https:");
			assert.equal(call.headers.host, host);
			assert.match(call.headers.Authorization, new RegExp(scope("fsn1")));
			assert.equal(call.headers["x-amz-date"], "20260102T030405Z");
		}
	});

	test(`${label}: multipart create, part and complete`, async () => {
		const calls = await capture(async () => {
			const upload = await new B2Bucket(config).createMultipartUpload("drive/big");
			const part = await upload.uploadPart(2, new Uint8Array([1, 2]));
			await upload.complete([part]).catch(() => undefined);
		});
		const target = `${prefix}/drive/big`;
		assert.deepEqual([calls[0].method, calls[0].url.host, calls[0].url.pathname, calls[0].url.searchParams.has("uploads")], ["POST", host, target, true]);
		assert.deepEqual([calls[1].method, calls[1].url.host, calls[1].url.pathname, calls[1].url.searchParams.get("partNumber"), calls[1].url.searchParams.get("uploadId")], ["PUT", host, target, "2", "u1"]);
		assert.deepEqual([calls[2].method, calls[2].url.host, calls[2].url.pathname, calls[2].url.searchParams.get("uploadId")], ["POST", host, target, "u1"]);
	});

	test(`${label}: the signature covers the URL actually requested`, async () => {
		const [call] = await capture(() => new B2Bucket(config).get("k/one"));
		const expected = await signAwsRequest({ method: "GET", url: call.url, headers: {}, body: "", region: "fsn1", service: "s3", credentials: creds, now: NOW });
		assert.equal(call.headers.Authorization, expected.Authorization);
	});

	test(`${label}: presigned PUT`, async () => {
		mock.timers.enable({ apis: ["Date"], now: NOW });
		let signed;
		try { signed = await presignPutUrl(config, "request-uploads/u1/x y", 7, 900); } finally { mock.timers.reset(); }
		const url = new URL(signed);
		assert.equal(url.host, host);
		assert.equal(url.pathname, `${prefix}/request-uploads/u1/x%20y`);
		assert.equal(url.searchParams.get("X-Amz-Credential"), `AKTEST/20260102/fsn1/s3/aws4_request`);
		assert.equal(url.searchParams.get("X-Amz-Date"), "20260102T030405Z");
		assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
		assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
		const expected = await presignS3Url({ method: "PUT", url: new URL(`https://${host}${prefix}/request-uploads/u1/x%20y`), headers: { "content-length": "7" }, region: "fsn1", credentials: creds, expiresSeconds: 900, now: NOW });
		assert.equal(signed, expected);
	});
}

test("a local MinIO over http uses path style on the given port", async () => {
	const calls = await capture(async () => { await new B2Bucket(local).put("k", "v"); });
	assert.equal(calls[0].url.href, "http://localhost:9000/mailbox/k");
	assert.equal(calls[0].headers.host, "localhost:9000");
	const presigned = new URL(await presignPutUrl(local, "k", 1, 60));
	assert.equal(presigned.origin + presigned.pathname, "http://localhost:9000/mailbox/k");
});

// --- Redirects ------------------------------------------------------------------------------------------------

test("a custom endpoint never follows a redirect with signed headers", async () => {
	const redirect = () => new Response(null, { status: 307, headers: { location: "https://evil.example/mailbox/k" } });
	const calls = await capture(async () => {
		await assert.rejects(new B2Bucket(virtual).get("k"), (error) => error.status === 307);
		await assert.rejects(new B2Bucket(path).put("k", "v"), (error) => error.status === 307);
	}, redirect);
	assert.deepEqual(calls.map((c) => c.init.redirect), ["manual", "manual"]);
});
