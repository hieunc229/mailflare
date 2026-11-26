import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const load = async (name, entryPoint, mocks = {}) => {
	const fixture = await loadFixture({ name, entryPoint, mocks });
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

/** The default setup: no QStash, no Upstash. */
const defaults = Object.fromEntries(Object.entries(vars).filter(([name]) => !/^(QSTASH|UPSTASH)_/.test(name)));

test("the Vercel runtime refuses to start without its services and names each one", () => {
	assert.deepEqual(runtimeEnv.vercelConfigProblems(vars), []);
	assert.deepEqual(runtimeEnv.vercelConfigProblems(defaults), []);
	const problems = runtimeEnv.vercelConfigProblems({}).join("\n");
	for (const name of ["DATABASE_URL", "S3_BUCKET", "CRON_SECRET", "APP_URL"]) assert.match(problems, new RegExp(name));
	assert.doesNotMatch(problems, /QStash|Upstash/i);
	assert.throws(() => runtimeEnv.createVercelEnv({}), /cannot run on Vercel/);
});

test("a partly configured QStash is reported", () => {
	assert.match(runtimeEnv.vercelConfigProblems({ ...defaults, QSTASH_TOKEN: "t" }).join("\n"), /partly configured/);
});

test("Vercel Queues is the default and QStash replaces it", () => {
	assert.ok(runtimeEnv.createVercelEnv(defaults).VERCEL_QUEUES);
	assert.equal(runtimeEnv.createVercelEnv(vars).VERCEL_QUEUES, undefined);
});

test("the Turso integration's variables stand in for DATABASE_URL", () => {
	const turso = { ...defaults, DATABASE_URL: undefined, TURSO_DATABASE_URL: "libsql://mail.turso.io", TURSO_AUTH_TOKEN: "turso-token" };
	const env = runtimeEnv.createVercelEnv(turso);
	assert.equal(env.DATABASE_URL, "libsql://mail.turso.io");
	assert.equal(env.DATABASE_AUTH_TOKEN, "turso-token");
	assert.equal(runtimeEnv.createVercelEnv({ ...turso, DATABASE_URL: vars.DATABASE_URL }).DATABASE_URL, vars.DATABASE_URL);
});

/** The parts of D1 the database limiter uses, over an in-memory SQLite database. */
function sqliteD1(sqlite) {
	const statement = (sql, params = []) => ({
		bind: (...values) => statement(sql, values),
		run: async () => void sqlite.prepare(sql).run(...params),
		first: async () => sqlite.prepare(sql).get(...params) ?? null,
	});
	return { prepare: (sql) => statement(sql) };
}

test("the database limiter creates its table, counts there and falls back to memory", async () => {
	const sqlite = new DatabaseSync(":memory:");
	const db = sqliteD1(sqlite);
	const open = () => limiter.openDatabaseRateLimiter({ db: () => db, dialect: "sqlite" }, "login", 2, 60);
	const results = [await open().limit({ key: "a" }), await open().limit({ key: "a" }), await open().limit({ key: "a" })];
	assert.deepEqual(results.map((r) => r.success), [true, true, false]);
	assert.doesNotMatch(sqlite.prepare("SELECT bucket FROM vercel_rate_limits").get().bucket, /:a$/);
	await withFetch(globalThis.fetch, async () => {
		const down = limiter.openDatabaseRateLimiter({ db: () => { throw new Error("down"); }, dialect: "sqlite" }, "login", 1, 60);
		assert.deepEqual([await down.limit({ key: "a" }), await down.limit({ key: "a" })].map((r) => r.success), [true, false]);
	});
});

test("a Vercel Queues send keeps a delayed message long enough, and one tick is asked for per five minutes", async () => {
	const sent = (globalThis.__queueSends = []);
	const queues = await load("vercel-queues", "server/runtime/vercel-queues.ts", {
		"@vercel/queue": "export const send = async (...args) => void globalThis.__queueSends.push(args); export const handleCallback = () => {};",
	});
	const outbound = queues.openVercelQueue("outbound");
	await outbound.send({ kind: "email.scheduled" }, { delaySeconds: 86400 });
	assert.deepEqual(sent[0], ["mailflare", { queue: "outbound", body: { kind: "email.scheduled" } }, { delaySeconds: 86400, retentionSeconds: 172800 }]);
	await assert.rejects(outbound.send({ imapPassword: "pw" }), /IMAP/);

	sent.length = 0;
	let now = 1_000 * 300_000 + 10_000;
	const schedule = queues.openVercelQueues("production", () => now);
	await schedule.ensureTick();
	await schedule.ensureTick();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0][2], { delaySeconds: 290, idempotencyKey: "tick-1001", retentionSeconds: 3600 });
	// Slightly before the mark counts as that mark's run.
	now = 1_001 * 300_000 - 2_000;
	await schedule.ensureTick();
	assert.equal(sent[1][2].idempotencyKey, "tick-1002");
	await queues.openVercelQueues("preview").ensureTick();
	assert.equal(sent.length, 2);
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

/** Variables for a setup whose only storage is Vercel Blob. */
const blobVars = { ...Object.fromEntries(Object.entries(defaults).filter(([name]) => !name.startsWith("S3_"))), BLOB_STORE_ID: "store_abc" };

test("Vercel Blob is used only without an S3 or Backblaze bucket", () => {
	assert.deepEqual(runtimeEnv.vercelConfigProblems(blobVars), []);
	const env = runtimeEnv.createVercelEnv(blobVars);
	assert.equal(typeof env.BUCKET.get, "function");
	assert.equal(typeof env.UPLOAD_PRESIGNER, "function");
	assert.equal(uploads.directUploadsEnabled(env), true);
	const both = runtimeEnv.createVercelEnv({ ...defaults, BLOB_STORE_ID: "store_abc" });
	assert.equal(both.BUCKET, undefined);
	assert.equal(both.UPLOAD_PRESIGNER, undefined);
	assert.match(runtimeEnv.vercelConfigProblems({ ...blobVars, S3_BUCKET: "half" }).join("\n"), /AWS S3 needs/);
});

test("an upload ticket for Blob carries the headers to send", async () => {
	const env = { MAILFLARE_RUNTIME: "vercel", UPLOAD_PRESIGNER: async (key, size) => ({ url: `https://blob.example/${size}`, headers: { "x-vercel-blob-access": "private" } }) };
	const ticket = await uploads.createUploadTicket(env, "u1", 5);
	assert.match(ticket.key, /^request-uploads\/u1\//);
	assert.equal(ticket.url, "https://blob.example/5");
	assert.deepEqual(ticket.headers, { "x-vercel-blob-access": "private" });
});

test("the Blob bucket encodes download paths, reads ranges and resumes multipart uploads", async () => {
	const calls = (globalThis.__blobCalls = []);
	const sdk = await load("vercel-blob", "server/runtime/vercel-blob.ts", {
		"@vercel/blob": `
			const record = (name, args) => globalThis.__blobCalls.push([name, ...args]);
			export class BlobNotFoundError extends Error {}
			export const get = async (...args) => { record("get", args); return { statusCode: 200, stream: new Response("0123456789").body, headers: new Headers({ "content-length": "10" }), blob: { etag: '"e"', uploadedAt: new Date(), contentType: "text/plain" } }; };
			export const head = async () => { throw new BlobNotFoundError(); };
			export const createMultipartUpload = async () => ({ key: "blob-key", uploadId: "blob-upload" });
			export const uploadPart = async (...args) => { record("uploadPart", args); return { etag: "p1", partNumber: 1 }; };
			export const completeMultipartUpload = async () => {};
			export const del = async () => {};
			export const list = async () => ({ blobs: [], hasMore: false });
			export const put = async () => ({ etag: "e" });
			export const issueSignedToken = async () => ({});
			export const presignUrl = async () => ({ presignedUrl: "" });
			export const parseStoreIdFromDelegationToken = () => "abc";
		`,
	});
	const bucket = new sdk.VercelBlobBucket({ storeId: "store_abc" });
	assert.equal(await bucket.head("missing"), null);

	const whole = await bucket.get("attachments/m/a/50% #1?.txt");
	assert.equal(calls.at(-1)[1], "attachments/m/a/50%25%20%231%3F.txt");
	assert.equal(await whole.text(), "0123456789");

	// This store ignores the range, so it is cut out locally.
	const part = await bucket.get("k", { range: { offset: 2, length: 3 } });
	assert.equal(calls.at(-1)[2].headers.range, "bytes=2-4");
	assert.equal(part.size, 10);
	assert.equal(await part.text(), "234");
	assert.equal(await (await bucket.get("k", { range: { suffix: 2 } })).text(), "89");

	const upload = await bucket.createMultipartUpload("drive/u/i");
	await bucket.resumeMultipartUpload("drive/u/i", upload.uploadId).uploadPart(1, new Uint8Array([1]));
	const [, pathname, , options] = calls.at(-1);
	assert.deepEqual([pathname, options.key, options.uploadId, options.partNumber, options.access], ["drive/u/i", "blob-key", "blob-upload", 1, "private"]);
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
	// The Vercel SDKs stay out of every other runtime.
	assert.equal(Object.values(result.metafile.inputs).some((input) => input.imports.some((entry) => entry.path.startsWith("@vercel/"))), false);
});
