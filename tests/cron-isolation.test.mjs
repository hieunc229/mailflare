import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-cron-isolation-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// jobs.ts imports every job implementation through "@/..."; only runScheduledJob is under test, so each of those
// imports is replaced by a stub that exports the same names.
const source = readFileSync(join(root, "src/lib/scheduled/jobs.ts"), "utf8");
const stubs = new Map([...source.matchAll(/import \{([^}]+)\} from "(@\/[^"]+)"/g)].map((m) => [m[2], m[1].split(",").map((n) => n.trim()).filter(Boolean)]));
await build({
	entryPoints: [join(root, "src/lib/scheduled/jobs.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	plugins: [{
		name: "stub-job-imports",
		setup(b) {
			b.onResolve({ filter: /^@\// }, (args) => ({ path: args.path, namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: (stubs.get(args.path) ?? []).map((name) => `export const ${name} = () => {};`).join("\n"), loader: "js" }));
		},
	}],
});
const { runScheduledJob } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function captureErrors() {
	const original = console.error;
	const calls = [];
	console.error = (...args) => calls.push(args);
	return { calls, restore: () => { console.error = original; } };
}

test("a rejected job is logged with its name and resolves to false", async () => {
	const log = captureErrors();
	try {
		assert.equal(await runScheduledJob({ name: "Trash retention", run: async () => { throw new Error("boom"); } }), false);
		assert.match(String(log.calls[0][0]), /Trash retention/);
		assert.equal(log.calls[0][1].message, "boom");
	} finally { log.restore(); }
});

test("a job that throws before returning a promise is contained too", async () => {
	const log = captureErrors();
	try {
		assert.equal(await runScheduledJob({ name: "Sync", run: () => { throw new Error("sync"); } }), false);
		assert.equal(log.calls.length, 1);
	} finally { log.restore(); }
});

test("one failing job does not stop the others from running", async () => {
	const log = captureErrors();
	const ran = [];
	try {
		const results = await Promise.all([
			{ name: "first", run: () => { throw new Error("sync"); } },
			{ name: "second", run: async () => { ran.push("second"); throw new Error("async"); } },
			{ name: "third", run: async () => { ran.push("third"); } },
		].map(runScheduledJob));
		assert.deepEqual(results, [false, false, true]);
		assert.deepEqual(ran, ["second", "third"]);
		assert.equal(log.calls.length, 2);
	} finally { log.restore(); }
});

test("the Worker hands every job to waitUntil on its own", () => {
	const worker = readFileSync(join(root, "worker.ts"), "utf8");
	assert.match(worker, /for \(const job of jobs\) ctx\.waitUntil\(runScheduledJob\(job\)\)/);
});
