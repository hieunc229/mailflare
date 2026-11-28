import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-awsreq-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { awsRequest } = await bundle("src/lib/aws/client.ts", "client.mjs");
const config = { accessKeyId: "AK", secretAccessKey: "SK", region: "us-east-1" };

function fakeFetch(t, impl) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	t.after(() => { globalThis.fetch = original; });
}

test("awsRequest rejects with TimeoutError when the server never answers", async (t) => {
	fakeFetch(t, (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
	await assert.rejects(awsRequest({ config, service: "s3", timeoutMs: 50 }), (e) => e.name === "TimeoutError");
});

test("the timer is cleared once headers arrive", async (t) => {
	let signal;
	fakeFetch(t, async (_url, init) => { signal = init.signal; return new Response("ok"); });
	await awsRequest({ config, service: "s3", timeoutMs: 30 });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(signal.aborted, false);
});

test("a non-2xx answer still throws AwsError", async (t) => {
	fakeFetch(t, async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
	await assert.rejects(awsRequest({ config, service: "s3" }), (e) => e.status === 404 && e.code === "NoSuchKey");
});
