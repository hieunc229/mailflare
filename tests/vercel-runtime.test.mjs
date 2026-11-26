import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const load = async (name, entryPoint) => {
	const fixture = await loadFixture({ name, entryPoint, mocks: {} });
	const module = await fixture.import();
	after(() => fixture.dispose());
	return module;
};

const queue = await load("vercel-queue", "server/runtime/vercel-queue.ts");
const limiter = await load("vercel-rate-limit", "server/runtime/vercel-rate-limit.ts");
const runtimeEnv = await load("vercel-env", "server/runtime/vercel-env.ts");
const sigv4 = await load("vercel-presign", "src/lib/aws/sigv4.ts");
const uploads = await load("vercel-uploads", "src/lib/uploads/direct.ts");
const dav = await load("vercel-dav", "server/runtime/vercel-dav.ts");

const vars = {
	DATABASE_URL: "postgres://user:pass@db.example.com/mail",
	S3_BUCKET: "mail",
	S3_REGION: "eu-west-1",
	S3_ACCESS_KEY_ID: "AKIATEST",
	S3_SECRET_ACCESS_KEY: "secret",
	QSTASH_TOKEN: "token",
	QSTASH_CURRENT_SIGNING_KEY: "current",
	QSTASH_NEXT_SIGNING_KEY: "next",
	UPSTASH_REDIS_REST_URL: "https://redis.example.com",
	UPSTASH_REDIS_REST_TOKEN: "token",
	CRON_SECRET: "cron",
	APP_URL: "https://mail.example.com/",
};

async function withFetch(handler, run) {
	const original = globalThis.fetch;
	const warn = console.warn;
	globalThis.fetch = handler;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
		console.warn = warn;
	}
}

test("the Vercel runtime refuses to start without its services and names each one", () => {
	assert.deepEqual(runtimeEnv.vercelConfigProblems(vars), []);
	const problems = runtimeEnv.vercelConfigProblems({}).join("\n");
	for (const name of ["DATABASE_URL", "S3_BUCKET", "QSTASH_TOKEN", "UPSTASH_REDIS_REST_URL", "CRON_SECRET", "APP_URL"]) assert.match(problems, new RegExp(name));
	assert.throws(() => runtimeEnv.createVercelEnv({}), /cannot run on Vercel/);
});

test("a local database file is refused", () => {
	for (const url of ["file:./mail.db", "./mail.db"]) {
		assert.ok(runtimeEnv.vercelConfigProblems({ ...vars, DATABASE_URL: url }).length > 0, url);
	}
});

test("the env passes variables through and falls back to the production domain", () => {
	const env = runtimeEnv.createVercelEnv({ ...vars, RESEND_API_KEY: "re_1", APP_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: "app.vercel.app" });
	assert.equal(env.RESEND_API_KEY, "re_1");
	assert.equal(env.APP_URL, "https://app.vercel.app");
	assert.equal(env.MAILFLARE_RUNTIME, "vercel");
});

test("a queue send publishes to QStash with the delay and an attempt counter", async () => {
	const calls = [];
	await withFetch(async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 201 }); }, async () => {
		const env = runtimeEnv.createVercelEnv(vars);
		await env.OUTBOUND_QUEUE.send({ kind: "webhook.retry", deliveryId: "d1" }, { delaySeconds: 30 });
	});
	assert.equal(calls[0].url, "https://qstash.upstash.io/v2/publish/https://mail.example.com/api/internal/queue/outbound");
	assert.equal(calls[0].init.headers["Upstash-Delay"], "30s");
	assert.deepEqual(JSON.parse(calls[0].init.body), { body: { kind: "webhook.retry", deliveryId: "d1" }, attempt: 1 });
});

test("an IMAP password never reaches the external queue", async () => {
	await withFetch(async () => assert.fail("must not publish"), async () => {
		const env = runtimeEnv.createVercelEnv(vars);
		await assert.rejects(env.OUTBOUND_QUEUE.send({ kind: "import.run", jobId: "j", imapPassword: "pw" }), /IMAP/);
	});
});

test("a failed publish is an error", async () => {
	await withFetch(async () => new Response("quota", { status: 429 }), async () => {
		await assert.rejects(runtimeEnv.createVercelEnv(vars).INBOUND_QUEUE.send({}), /429/);
	});
});

function qstashToken(key, body, destination, claims = {}) {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "Upstash", sub: destination, exp: now + 300, nbf: now - 5, body: createHash("sha256").update(body).digest("base64url"), ...claims })}`;
	return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
}

test("only a QStash signature for this URL and body is accepted", async () => {
	const keys = { currentSigningKey: "current", nextSigningKey: "next" };
	const url = "https://mail.example.com/api/internal/queue/inbound";
	const verify = (token, body = "{}") => queue.verifyQStashSignature(keys, token, body, url);
	assert.equal(await verify(qstashToken("current", "{}", url)), true);
	assert.equal(await verify(qstashToken("next", "{}", url)), true);
	assert.equal(await verify(qstashToken("other", "{}", url)), false);
	assert.equal(await verify(qstashToken("current", "{}", url), '{"a":1}'), false);
	assert.equal(await verify(qstashToken("current", "{}", `${url}x`)), false);
	assert.equal(await verify(qstashToken("current", "{}", url, { exp: 1 })), false);
	assert.equal(await verify(qstashToken("current", "{}", url, { iss: "x" })), false);
	assert.equal(await verify(null), false);
	assert.equal(await verify("a.b.c"), false);
});

test("the Redis limiter counts in Redis and falls back to memory", async () => {
	let count = 0;
	const config = { url: "https://redis.example.com", token: "t" };
	await withFetch(async () => Response.json([{ result: ++count }, { result: 1 }]), async () => {
		const limit = limiter.openUpstashRateLimiter(config, "login", 2, 60);
		assert.deepEqual([await limit.limit({ key: "a" }), await limit.limit({ key: "a" }), await limit.limit({ key: "a" })].map((r) => r.success), [true, true, false]);
	});
	await withFetch(async () => { throw new Error("down"); }, async () => {
		const limit = limiter.openUpstashRateLimiter(config, "login", 1, 60);
		assert.deepEqual([await limit.limit({ key: "a" }), await limit.limit({ key: "a" })].map((r) => r.success), [true, false]);
	});
});

test("presigned URLs match the AWS published example", async () => {
	const url = await sigv4.presignS3Url({
		method: "GET",
		url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
		region: "us-east-1",
		credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
		expiresSeconds: 86400,
		now: new Date("2013-05-24T00:00:00Z"),
	});
	assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

function uploadEnv(runtime, objects) {
	return {
		...vars,
		MAILFLARE_RUNTIME: runtime,
		BUCKET: {
			get: async (key) => (objects.has(key) ? { size: objects.get(key).length, arrayBuffer: async () => new TextEncoder().encode(objects.get(key)).buffer } : null),
			delete: async (key) => void objects.delete(key),
		},
	};
}

const key = "request-uploads/u1/11111111-1111-1111-1111-111111111111";
const stored = (headers) => new Request("https://mail.example.com/api/send", { method: "POST", headers: { "x-mailflare-upload": key, "x-mailflare-upload-type": "text/plain", ...headers } });

test("a stored body is restored once, only for its owner", async () => {
	const objects = new Map([[key, "hello"]]);
	const env = uploadEnv("vercel", objects);
	await assert.rejects(uploads.resolveUploadedRequest(env, stored(), "u2", 100), /not found/);
	await assert.rejects(uploads.resolveUploadedRequest(env, stored(), "u1", 2), /too large/);
	const request = await uploads.resolveUploadedRequest(env, stored(), "u1", 100);
	assert.equal(await request.text(), "hello");
	assert.equal(request.headers.get("content-type"), "text/plain");
	assert.equal(request.headers.get("content-length"), "5");
	assert.equal(request.headers.get("x-mailflare-upload"), null);
	assert.equal(objects.size, 0);
});

test("other runtimes ignore the upload header", async () => {
	for (const runtime of [undefined, "node"]) {
		const objects = new Map([[key, "hello"]]);
		const original = stored();
		assert.equal(await uploads.resolveUploadedRequest(uploadEnv(runtime, objects), original, "u1", 100), original);
		assert.equal(objects.size, 1);
	}
});

test("a rewritten DAV request gets its own path back", () => {
	assert.equal(dav.davRequestTarget("/dav/principals/u1/"), "/dav/principals/u1/");
	assert.equal(dav.davRequestTarget("/api/internal/dav?__dav=%2Fdav%2Fprincipals%2Fu1"), "/dav/principals/u1");
});

test("the self-hosted server bundle imports no Next module Node cannot load", async () => {
	const { build } = await import("esbuild");
	// `next/server` and `next/headers` resolve inside a Next build only; in dist/server.mjs they stop the start.
	const result = await build({
		entryPoints: ["server/index.ts"],
		bundle: true,
		write: false,
		metafile: true,
		platform: "node",
		format: "esm",
		packages: "external",
		tsconfig: "tsconfig.json",
		alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
		logLevel: "silent",
	});
	const offenders = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
		input.imports.filter((entry) => entry.external && entry.path.startsWith("next/")).map((entry) => `${file} imports ${entry.path}`));
	assert.deepEqual(offenders, []);
});
