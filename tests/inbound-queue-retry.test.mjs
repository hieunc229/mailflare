import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const { settleFailedInboundMessage, INBOUND_SCHEMA_RETRY_DELAY_SECONDS } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

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

test("other errors keep the 10 s retry", () => {
	const msg = fakeMessage(2);
	settleFailedInboundMessage(msg, new Error("R2 timeout"));
	assert.deepEqual(msg.calls, [["retry", { delaySeconds: 10 }]]);
});

test("other errors keep retrying every 10 s past the old three attempts, never acked", () => {
	for (const attempts of [4, 12]) {
		const msg = fakeMessage(attempts);
		settleFailedInboundMessage(msg, new Error("R2 timeout"));
		assert.deepEqual(msg.calls, [["retry", { delaySeconds: 10 }]]);
	}
});
