import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-s3-review-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { getS3Config, getObjectStorageConfig, describeB2Problem, storageStartupProblem } = await bundle("src/lib/storage/b2-config.ts", "config.mjs");
const { withStorage } = await bundle("src/lib/storage/index.ts", "index.mjs");
const { B2Bucket } = await bundle("src/lib/storage/b2-bucket.ts", "bucket.mjs");

const env = (extra = {}) => ({ S3_BUCKET: "mailbox", S3_REGION: "fsn1", S3_ENDPOINT: "fsn1.your-objectstorage.com", S3_ACCESS_KEY_ID: "AK", S3_SECRET_ACCESS_KEY: "sk", ...extra });

test("an IP-literal endpoint is addressed by path, never as bucket.<ip>", async () => {
	for (const endpoint of ["10.0.0.5:9000", "https://192.168.1.5", "[2001:db8::1]:9000"]) {
		const config = getS3Config(env({ S3_ENDPOINT: endpoint }));
		assert.equal(config?.pathStyle, true, endpoint);
	}
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => { calls.push(String(input)); return new Response("", { status: 200 }); };
	try { await new B2Bucket(getS3Config(env({ S3_ENDPOINT: "10.0.0.5:9000" }))).put("k", "v"); } finally { globalThis.fetch = original; }
	assert.equal(calls[0], "https://10.0.0.5:9000/mailbox/k");
});

test("with an endpoint, AWS_* credentials and region are not borrowed", () => {
	const aws = { AWS_ACCESS_KEY_ID: "SESKEY", AWS_SECRET_ACCESS_KEY: "sessecret", AWS_REGION: "us-east-1" };
	assert.equal(getS3Config(env({ S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, ...aws })), null);
	assert.match(describeB2Problem(env({ S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, ...aws })), /S3_ACCESS_KEY_ID/);
	assert.equal(getS3Config(env({ S3_REGION: undefined, ...aws })), null);
	// Without an endpoint the fallback is unchanged.
	assert.equal(getS3Config({ S3_BUCKET: "b", ...aws })?.keyId, "SESKEY");
});

test("hosts that cannot resolve are refused", () => {
	for (const bad of ["foo.com.", "foo..com", "-foo.com", "*.foo.com", "foo.com:0", "foo_.com-", "https://foo.com:0"]) {
		assert.equal(getS3Config(env({ S3_ENDPOINT: bad })), null, bad);
	}
	assert.equal(getS3Config(env({ S3_ENDPOINT: "s3.eu-central-1.wasabisys.com" }))?.endpoint, "s3.eu-central-1.wasabisys.com");
	assert.equal(getS3Config(env({ S3_ENDPOINT: "https://münchen.example" }))?.endpoint, "xn--mnchen-3ya.example");
});

test("a leftover B2 variable does not hide an S3_ENDPOINT problem", () => {
	assert.match(describeB2Problem(env({ S3_ENDPOINT: "https://h.example.com/x", B2_KEY_ID: "k" })), /S3_ENDPOINT must be a host/);
	assert.equal(describeB2Problem(env({ B2_KEY_ID: "k" })), null);
});

test("storageStartupProblem reports a broken S3_ENDPOINT only", () => {
	assert.equal(storageStartupProblem(env()), null);
	assert.equal(storageStartupProblem({}), null);
	assert.equal(storageStartupProblem({ S3_BUCKET: "half" }), null, "an AWS half-setup keeps its old behaviour");
	assert.match(storageStartupProblem(env({ S3_ENDPOINT: "http://minio:9000" })), /S3_ENDPOINT must use https/);
	assert.equal(storageStartupProblem(env({ S3_ENDPOINT: "http://minio:9000", B2_KEY_ID: "k", B2_APPLICATION_KEY: "s", B2_BUCKET: "b", B2_ENDPOINT: "s3.us-west-004.backblazeb2.com" })), null, "B2 is in use");
});

test("withStorage logs a broken S3_ENDPOINT instead of silently using R2", () => {
	const logged = [];
	const original = console.error;
	console.error = (...args) => logged.push(args.join(" "));
	try {
		const broken = { BUCKET: "r2", ...env({ S3_ENDPOINT: "http://minio:9000" }) };
		assert.equal(withStorage(broken), broken);
		withStorage(broken);
	} finally { console.error = original; }
	assert.equal(logged.length, 1);
	assert.match(logged[0], /S3_ENDPOINT must use https/);
	assert.doesNotMatch(logged[0], /sk\b|AK\b/);
});
