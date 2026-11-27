import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-s3-config-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { getB2Config, getS3Config, getObjectStorageConfig, getStorageStatus, describeB2Problem } = await bundle("src/lib/storage/b2-config.ts", "config.mjs");
const { withStorage } = await bundle("src/lib/storage/index.ts", "index.mjs");

const creds = { S3_ACCESS_KEY_ID: "AK", S3_SECRET_ACCESS_KEY: "sk" };
const env = (extra = {}) => ({ S3_BUCKET: "mailbox", S3_REGION: "fsn1", S3_ENDPOINT: "fsn1.your-objectstorage.com", ...creds, ...extra });

// --- AWS behaviour, unchanged ---------------------------------------------------------------------------------

test("characterization: without S3_ENDPOINT only AWS regions work and the provider is s3", () => {
	const base = { S3_BUCKET: "b", ...creds };
	assert.deepEqual(getS3Config({ ...base, S3_REGION: "eu-west-2" }), { keyId: "AK", applicationKey: "sk", bucket: "b", region: "eu-west-2", endpoint: "s3.eu-west-2.amazonaws.com" });
	for (const region of ["fsn1", "auto", "US-EAST-1", "nl-ams"]) assert.equal(getS3Config({ ...base, S3_REGION: region }), null, region);
	assert.equal(getObjectStorageConfig({ ...base, S3_REGION: "us-east-1" }).provider, "s3");
	assert.deepEqual(getStorageStatus({ ...base, S3_REGION: "us-east-1" }), { provider: "s3", configured: true, bucket: "b", endpoint: "s3.us-east-1.amazonaws.com" });
	assert.equal(getS3Config({ ...base, S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true" }).pathStyle, undefined);
	assert.equal(describeB2Problem({ S3_BUCKET: "b" }), "AWS S3 needs S3_BUCKET, S3_REGION and credentials (S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).");
	assert.equal(describeB2Problem({ B2_KEY_ID: "k" }), "Backblaze B2 needs B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT together.");
});

// --- Endpoint normalisation -----------------------------------------------------------------------------------

test("S3_ENDPOINT is normalised to a lowercase host", () => {
	for (const [input, host] of [
		["fsn1.your-objectstorage.com", "fsn1.your-objectstorage.com"],
		["https://s3.eu-central-2.idrivee2.com", "s3.eu-central-2.idrivee2.com"],
		["  HTTPS://S3.Eu-Central-2.IDrivee2.com/  ", "s3.eu-central-2.idrivee2.com"],
		["https://minio.example.com:9443", "minio.example.com:9443"],
		["https://minio.example.com:443/", "minio.example.com"],
	]) {
		const config = getS3Config(env({ S3_ENDPOINT: input }));
		assert.equal(config?.endpoint, host, input);
		assert.equal(config.protocol, "https");
		assert.equal(config.pathStyle, false);
	}
});

test("S3_ENDPOINT rejects paths, queries, credentials, other schemes and junk", () => {
	for (const bad of ["https://h.example.com/bucket", "h.example.com/x", "https://h.example.com?a=1", "https://h.example.com/?a=1", "https://h.example.com#f", "https://user:pw@h.example.com", "https://user@h.example.com", "ftp://h.example.com", "s3://h.example.com", "a b.example.com", "https://", "://x", "https://h.example.com:99999"]) {
		assert.equal(getS3Config(env({ S3_ENDPOINT: bad })), null, bad);
		assert.match(describeB2Problem(env({ S3_ENDPOINT: bad })), /S3_ENDPOINT must be a host/, bad);
	}
});

test("http is accepted only for loopback hosts on the Node runtime", () => {
	for (const host of ["localhost:9000", "127.0.0.1:9000", "[::1]:9000", "localhost"]) {
		const config = getS3Config(env({ S3_ENDPOINT: `http://${host}`, MAILFLARE_RUNTIME: "node" }));
		assert.equal(config?.protocol, "http", host);
		assert.equal(config.endpoint, host);
		assert.equal(config.pathStyle, true, "loopback hosts cannot take bucket subdomains");
		assert.equal(getS3Config(env({ S3_ENDPOINT: `http://${host}` })), null, `${host} off Node`);
		assert.equal(getS3Config(env({ S3_ENDPOINT: `http://${host}`, MAILFLARE_RUNTIME: "vercel" })), null, `${host} on Vercel`);
	}
	for (const bad of ["http://minio.example.com", "http://192.168.1.5:9000", "http://localhost.example.com", "http://127.0.0.1.example.com"]) {
		assert.equal(getS3Config(env({ S3_ENDPOINT: bad, MAILFLARE_RUNTIME: "node" })), null, bad);
		assert.match(describeB2Problem(env({ S3_ENDPOINT: bad, MAILFLARE_RUNTIME: "node" })), /https/, bad);
	}
	assert.match(describeB2Problem(env({ S3_ENDPOINT: "http://localhost:9000" })), /Node/);
	assert.equal(getS3Config(env({ S3_ENDPOINT: "https://localhost:9000" }))?.protocol, "https");
});

// --- Region ---------------------------------------------------------------------------------------------------

test("with an endpoint the region may be any short lowercase label", () => {
	for (const region of ["auto", "fsn1", "us-east-1", "eu-central-2", "0", "a".repeat(63)]) assert.equal(getS3Config(env({ S3_REGION: region }))?.region, region, region);
	for (const region of ["", "-a", "A", "us_east", "a b", "a".repeat(64), "eu/1"]) {
		assert.equal(getS3Config(env({ S3_REGION: region })), null, region);
	}
	assert.match(describeB2Problem(env({ S3_REGION: "US East" })), /S3_REGION.*S3_ENDPOINT|S3_ENDPOINT.*S3_REGION/);
	assert.equal(getS3Config(env({ S3_REGION: undefined, AWS_REGION: "us-east-1" }))?.region, "us-east-1");
});

// --- Path style -----------------------------------------------------------------------------------------------

test("S3_FORCE_PATH_STYLE is true only for true or 1", () => {
	for (const [value, expected] of [["true", true], ["1", true], [" TRUE ", true], ["false", false], ["0", false], ["", false], ["yes", false], [undefined, false]]) {
		assert.equal(getS3Config(env({ S3_FORCE_PATH_STYLE: value })).pathStyle, expected, String(value));
	}
});

test("virtual-hosted style needs a DNS-safe bucket; path style does not", () => {
	for (const bucket of ["My_Bucket", "a.b", "ab", "-ab", "ab-", "a".repeat(64), "has space", "UPPER"]) {
		assert.equal(getS3Config(env({ S3_BUCKET: bucket })), null, bucket);
		assert.match(describeB2Problem(env({ S3_BUCKET: bucket })), /S3_BUCKET.*S3_FORCE_PATH_STYLE/, bucket);
	}
	for (const bucket of ["My_Bucket", "a.b", "ab", "UPPER"]) assert.equal(getS3Config(env({ S3_BUCKET: bucket, S3_FORCE_PATH_STYLE: "1" }))?.bucket, bucket, bucket);
	for (const bucket of ["a/b", "a b", "a?b", "..", "x".repeat(256)]) assert.equal(getS3Config(env({ S3_BUCKET: bucket, S3_FORCE_PATH_STYLE: "1" })), null, bucket);
	assert.equal(getS3Config(env({ S3_BUCKET: "good-bucket-1" }))?.bucket, "good-bucket-1");
});

// --- Precedence, provider, status -----------------------------------------------------------------------------

test("B2 wins over S3; an endpoint makes the provider s3-compatible", () => {
	assert.equal(getObjectStorageConfig(env()).provider, "s3-compatible");
	const b2 = { B2_KEY_ID: "k", B2_APPLICATION_KEY: "s", B2_BUCKET: "b", B2_ENDPOINT: "s3.us-west-004.backblazeb2.com" };
	assert.equal(getObjectStorageConfig({ ...env(), ...b2 }).provider, "backblaze");
	assert.equal(getB2Config({ ...env(), ...b2 }).bucket, "b");
});

test("a bad S3_ENDPOINT never falls back to AWS", () => {
	const bad = env({ S3_REGION: "us-east-1", S3_ENDPOINT: "https://x.example.com/path" });
	assert.equal(getObjectStorageConfig(bad), null);
});

test("the status of an s3-compatible bucket shows the endpoint and no secrets", () => {
	const status = getStorageStatus(env());
	assert.deepEqual(status, { provider: "s3-compatible", configured: true, bucket: "mailbox", endpoint: "fsn1.your-objectstorage.com", pathStyle: false });
	assert.deepEqual(getStorageStatus(env({ S3_FORCE_PATH_STYLE: "true" })).pathStyle, true);
	assert.doesNotMatch(JSON.stringify(status), /AK|sk|secret/i);
});

// --- Problems -------------------------------------------------------------------------------------------------

test("describeB2Problem names what is wrong with an S3-compatible setup", () => {
	assert.equal(describeB2Problem(env()), null);
	assert.match(describeB2Problem(env({ S3_ENDPOINT: "https://h.example.com/x" })), /S3_ENDPOINT must be a host such as fsn1\.your-objectstorage\.com/);
	assert.match(describeB2Problem(env({ S3_ENDPOINT: "http://minio.example.com" })), /S3_ENDPOINT must use https/);
	assert.match(describeB2Problem(env({ S3_REGION: "Bad Region" })), /S3_REGION/);
	assert.match(describeB2Problem(env({ S3_BUCKET: "My_Bucket" })), /DNS/);
	assert.match(describeB2Problem(env({ S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined })), /S3_BUCKET, S3_REGION, S3_ENDPOINT and credentials/);
	assert.match(describeB2Problem({ S3_ENDPOINT: "fsn1.your-objectstorage.com" }), /S3_BUCKET, S3_REGION, S3_ENDPOINT and credentials/);
	for (const message of ["Bad Region", "x"]) assert.doesNotMatch(String(describeB2Problem(env({ S3_REGION: message }))), /sk|AK/);
});

test("withStorage serves BUCKET for an S3-compatible endpoint", () => {
	const plain = { BUCKET: "r2" };
	const served = withStorage({ ...plain, ...env() });
	assert.notEqual(served.BUCKET, "r2");
	assert.equal(withStorage({ BUCKET: "r2", ...env({ S3_ENDPOINT: "https://h.example.com/x" }) }).BUCKET, "r2");
});
