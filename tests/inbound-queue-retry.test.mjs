import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-inbound-queue-retry-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { utils: join(root, "worker-utils.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});

const { settleInboundFailure, settleFailedInboundMessage, inboundRetryDelaySeconds, isFinalInboundAttempt, INBOUND_MAX_RETRIES, INBOUND_SCHEMA_RETRY_DELAY_SECONDS } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

function fakeMessage(attempts) {
	const calls = [];
	return { calls, attempts, ack: () => calls.push(["ack"]), retry: (options) => calls.push(["retry", options]) };
}

// Drizzle wraps the driver message: "Failed query: …" with the driver error on `cause`.
const wrapped = (message) => Object.assign(new Error("Failed query: insert into \"messages\" ..."), { cause: new Error(message) });

for (const [dialect, message] of [
	["D1/SQLite", "table messages has no column named new_col: SQLITE_ERROR"],
	["D1/SQLite select", "no such column: messages.new_col: SQLITE_ERROR"],
	["PostgreSQL", 'column "new_col" of relation "messages" does not exist'],
	["PostgreSQL select (unquoted, table-qualified)", "column messages.new_col does not exist"],
	["MySQL", "Unknown column 'new_col' in 'field list'"],
]) {
	test(`schema mismatch (${dialect}) retries later and is never acked`, () => {
		const msg = fakeMessage(1);
		settleFailedInboundMessage(msg, wrapped(message));
		assert.deepEqual(msg.calls, [["retry", { delaySeconds: INBOUND_SCHEMA_RETRY_DELAY_SECONDS }]]);
		assert.ok(INBOUND_SCHEMA_RETRY_DELAY_SECONDS >= 300);
	});
}

test("schema mismatch keeps being retried past the old attempt limit", () => {
	const msg = fakeMessage(9);
	settleFailedInboundMessage(msg, wrapped("no such column: x"));
	assert.deepEqual(msg.calls, [["retry", { delaySeconds: INBOUND_SCHEMA_RETRY_DELAY_SECONDS }]]);
});

test("other errors back off from 10 s and are never acked", () => {
	const msg = fakeMessage(2);
	settleFailedInboundMessage(msg, new Error("R2 timeout"));
	assert.deepEqual(msg.calls, [["retry", { delaySeconds: 20 }]]);
	const first = fakeMessage(1);
	settleFailedInboundMessage(first, new Error("R2 timeout"));
	assert.deepEqual(first.calls, [["retry", { delaySeconds: 10 }]]);
});

test("backoff is capped at an hour and the retries span hours, not minutes", () => {
	assert.equal(inboundRetryDelaySeconds(12), 3600);
	let total = 0;
	for (let attempt = 1; attempt <= INBOUND_MAX_RETRIES; attempt += 1) total += inboundRetryDelaySeconds(attempt);
	assert.ok(total >= 3 * 3600, `retry window ${total}s`);
});

test("only the attempt after max_retries is final", () => {
	assert.equal(isFinalInboundAttempt(INBOUND_MAX_RETRIES), false);
	assert.equal(isFinalInboundAttempt(INBOUND_MAX_RETRIES + 1), true);
});

// Queue handler wiring: the last attempt must move the raw mail aside and ack; earlier attempts retry.
function fakeBucket(keys) {
	const objects = new Map(keys.map((k) => [k, new TextEncoder().encode("raw").buffer]));
	return {
		objects,
		async get(key) {
			const body = objects.get(key);
			return body ? { arrayBuffer: async () => body } : null;
		},
		async put(key, body) {
			objects.set(key, body);
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}
const inboundBody = { from: "a@example.com", to: "me@example.org", rawR2Key: "inbound/abc" };
const withBody = (msg) => Object.assign(msg, { body: inboundBody });

test("final attempt moves the raw mail to dead/ then acks", async () => {
	const BUCKET = fakeBucket(["inbound/abc"]);
	const msg = withBody(fakeMessage(INBOUND_MAX_RETRIES + 1));
	await settleInboundFailure(msg, { BUCKET }, new Error("D1 down"));
	assert.deepEqual(msg.calls, [["ack"]]);
	assert.ok(BUCKET.objects.has("dead/abc"));
	assert.ok(!BUCKET.objects.has("inbound/abc"));
});

test("final attempt whose move fails falls back to retry and never acks", async () => {
	const BUCKET = fakeBucket(["inbound/abc"]);
	BUCKET.put = async () => {
		throw new Error("R2 down");
	};
	const msg = withBody(fakeMessage(INBOUND_MAX_RETRIES + 1));
	await settleInboundFailure(msg, { BUCKET }, new Error("D1 down"));
	assert.equal(msg.calls.some((c) => c[0] === "ack"), false);
	assert.equal(msg.calls.filter((c) => c[0] === "retry").length, 1);
	assert.ok(BUCKET.objects.has("inbound/abc"));
});

test("an earlier attempt retries with backoff and leaves the raw mail", async () => {
	const BUCKET = fakeBucket(["inbound/abc"]);
	const msg = withBody(fakeMessage(INBOUND_MAX_RETRIES));
	await settleInboundFailure(msg, { BUCKET }, new Error("D1 down"));
	assert.deepEqual(msg.calls, [["retry", { delaySeconds: 3600 }]]);
	assert.ok(BUCKET.objects.has("inbound/abc"));
	assert.ok(!BUCKET.objects.has("dead/abc"));
});

test("a schema mismatch on the final attempt is still dead-lettered, not retried into a drop", async () => {
	const BUCKET = fakeBucket(["inbound/abc"]);
	const msg = withBody(fakeMessage(INBOUND_MAX_RETRIES + 1));
	await settleInboundFailure(msg, { BUCKET }, wrapped("no such column: x"));
	assert.deepEqual(msg.calls, [["ack"]]);
	assert.ok(BUCKET.objects.has("dead/abc"));
});

test("the queue handler in worker.ts routes failed inbound mail through settleInboundFailure", () => {
	const source = readFileSync(join(root, "worker.ts"), "utf8");
	assert.match(source, /await settleInboundFailure\(/);
	assert.doesNotMatch(source, /settleFailedInboundMessage\(/);
});
