import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "s3-endpoint-node", entryPoint: "server/runtime/env.ts", mocks: {} });
const { createNodeRuntime } = await fixture.import();
const data = mkdtempSync(join(tmpdir(), "mailflare-s3-node-"));
after(() => { fixture.dispose(); rmSync(data, { recursive: true, force: true }); });

const NAMES = ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_FORCE_PATH_STYLE", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_DEFAULT_REGION", "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT", "DATABASE_URL"];

function withVars(vars, run) {
	const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
	for (const name of NAMES) delete process.env[name];
	Object.assign(process.env, { DATA_DIR: data }, vars);
	try { return run(); } finally { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); }
}

const bucketVars = { S3_BUCKET: "mailbox", S3_REGION: "fsn1", S3_ACCESS_KEY_ID: "AK", S3_SECRET_ACCESS_KEY: "sk" };

test("Node refuses to start on a broken S3_ENDPOINT instead of using local files", () => {
	assert.throws(() => withVars({ ...bucketVars, S3_ENDPOINT: "http://minio.example.com:9000" }, createNodeRuntime), /S3_ENDPOINT must use https/);
	assert.throws(() => withVars({ ...bucketVars, S3_ENDPOINT: "https://h.example.com/x" }, createNodeRuntime), /S3_ENDPOINT must be a host/);
});

test("Node serves BUCKET from an S3-compatible endpoint, a local MinIO included", () => {
	for (const endpoint of ["fsn1.your-objectstorage.com", "http://127.0.0.1:9000"]) {
		const runtime = withVars({ ...bucketVars, S3_ENDPOINT: endpoint }, createNodeRuntime);
		assert.equal(runtime.env.S3_ENDPOINT, endpoint);
		assert.equal(typeof runtime.env.BUCKET.get, "function");
		assert.notEqual(runtime.env.BUCKET.constructor.name, "FileBucket");
	}
});

test("Node does not sign requests to another provider with the AWS_* keys", () => {
	const aws = { AWS_ACCESS_KEY_ID: "SESKEY", AWS_SECRET_ACCESS_KEY: "sessecret", AWS_REGION: "us-east-1", S3_BUCKET: "mailbox", S3_ENDPOINT: "fsn1.your-objectstorage.com" };
	assert.throws(() => withVars(aws, createNodeRuntime), /S3_BUCKET, S3_REGION, S3_ENDPOINT and credentials/);
});

test("Node still takes AWS_* credentials for plain AWS S3", () => {
	const runtime = withVars({ AWS_ACCESS_KEY_ID: "SESKEY", AWS_SECRET_ACCESS_KEY: "sessecret", AWS_REGION: "us-east-1", S3_BUCKET: "mailbox" }, createNodeRuntime);
	assert.notEqual(runtime.env.BUCKET.constructor.name, "FileBucket");
});
