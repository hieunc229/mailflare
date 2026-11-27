import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const load = async (name, entryPoint) => {
	const fixture = await loadFixture({ name, entryPoint, mocks: {} });
	const module = await fixture.import();
	after(() => fixture.dispose());
	return module;
};

const runtimeEnv = await load("s3-endpoint-vercel-env", "server/runtime/vercel-env.ts");
const next = await load("s3-endpoint-next-config", "next.config.ts");

const base = {
	DATABASE_URL: "postgres://user:pass@db.example.com/mail",
	S3_BUCKET: "mail",
	S3_REGION: "fsn1",
	S3_ENDPOINT: "fsn1.your-objectstorage.com",
	S3_ACCESS_KEY_ID: "AK",
	S3_SECRET_ACCESS_KEY: "sk",
	CRON_SECRET: "cron",
	APP_URL: "https://mail.example.com",
};

test("Vercel starts on an S3-compatible bucket and passes the variables through", () => {
	assert.deepEqual(runtimeEnv.vercelConfigProblems(base), []);
	const env = runtimeEnv.createVercelEnv({ ...base, S3_FORCE_PATH_STYLE: "true" });
	assert.equal(env.S3_ENDPOINT, "fsn1.your-objectstorage.com");
	assert.equal(env.S3_FORCE_PATH_STYLE, "true");
	assert.equal(env.BUCKET, undefined, "withStorage serves BUCKET, not Vercel Blob");
});

test("Vercel names a bad S3_ENDPOINT instead of falling back to Blob", () => {
	const problems = runtimeEnv.vercelConfigProblems({ ...base, S3_ENDPOINT: "https://h.example.com/path", BLOB_STORE_ID: "store" }).join("\n");
	assert.match(problems, /S3_ENDPOINT must be a host/);
	assert.match(runtimeEnv.vercelConfigProblems({ ...base, S3_ENDPOINT: "http://localhost:9000" }).join("\n"), /S3_ENDPOINT must use https/);
});

test("the CSP allows browser uploads to the S3-compatible bucket, in both styles", () => {
	assert.ok(next.uploadSources(base).includes("https://mail.fsn1.your-objectstorage.com"));
	assert.ok(next.uploadSources({ ...base, S3_FORCE_PATH_STYLE: "true" }).includes("https://fsn1.your-objectstorage.com"));
	assert.ok(next.uploadSources({ ...base, S3_ENDPOINT: "https://S3.Example.com:9000/" }).includes("https://mail.s3.example.com:9000"));
	assert.ok(!next.uploadSources({ ...base, S3_ENDPOINT: "https://h.example.com/x" }).some((source) => source.includes("h.example.com")));
	assert.ok(next.uploadSources({ S3_BUCKET: "mail", S3_REGION: "eu-west-1" }).includes("https://mail.s3.eu-west-1.amazonaws.com"));
});
