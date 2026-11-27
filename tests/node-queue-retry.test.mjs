import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-node-queue-retry-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { queue: join(root, "server", "runtime", "queue.ts") },
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

const { InProcessQueue, inboundRetryDelayMs, INBOUND_QUEUE_OPTIONS } = await import(pathToFileURL(join(outDir, "queue.mjs")).href);

const flush = () => new Promise((r) => setImmediate(r));

async function failingRun(t, queue) {
	const errors = t.mock.method(console, "error", () => {});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	queue.setConsumer(async () => {
		calls++;
		throw new Error("db down");
	});
	await queue.send({});
	for (let i = 0; i < 40; i++) {
		t.mock.timers.tick(300_000);
		await flush();
	}
	return { calls, errors };
}

test("inboundRetryDelayMs doubles from 10 s and caps at 300 s", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(inboundRetryDelayMs), [10000, 20000, 40000, 80000, 160000, 300000, 300000]);
});

test("inbound queue retries 12 times then gives up", async (t) => {
	const { calls, errors } = await failingRun(t, new InProcessQueue("mailflare-inbound", INBOUND_QUEUE_OPTIONS));
	assert.equal(calls, 13);
	assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes("giving up after 12 retries")));
});

test("default queue keeps 3 retries 10 s apart", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const q = new InProcessQueue("x");
	q.setConsumer(async () => {
		calls++;
		throw new Error("fail");
	});
	await q.send({});
	t.mock.timers.tick(0);
	await flush();
	assert.equal(calls, 1);
	t.mock.timers.tick(9_999);
	await flush();
	assert.equal(calls, 1);
	t.mock.timers.tick(1);
	await flush();
	assert.equal(calls, 2);
	for (let i = 0; i < 10; i++) {
		t.mock.timers.tick(10_000);
		await flush();
	}
	assert.equal(calls, 4);
});

test("inbound queue spaces retries 10 s, 20 s, 40 s apart", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const q = new InProcessQueue("mailflare-inbound", INBOUND_QUEUE_OPTIONS);
	q.setConsumer(async () => {
		calls++;
		throw new Error("fail");
	});
	await q.send({});
	for (const [wait, expected] of [[0, 1], [9_999, 1], [1, 2], [19_999, 2], [1, 3], [39_999, 3], [1, 4]]) {
		t.mock.timers.tick(wait);
		await flush();
		assert.equal(calls, expected);
	}
});

test("the Node runtime opens the inbound queue with the inbound options", () => {
	assert.equal(INBOUND_QUEUE_OPTIONS.maxRetries, 12);
	assert.match(readFileSync(join(root, "server", "runtime", "env.ts"), "utf8"), /openQueue\("mailflare-inbound", INBOUND_QUEUE_OPTIONS\)/);
});
