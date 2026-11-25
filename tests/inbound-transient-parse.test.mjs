import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "tests", ".tmp-inbound-transient-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// The parser is replaced so each test chooses how it fails.
const mocks = {
	"@/lib/email/parse": `
		export class MimeLimitError extends Error {}
		globalThis.__MimeLimitError = MimeLimitError;
		export async function parseRawMime(raw) { return globalThis.__parse(raw); }`,
};
await build({
	entryPoints: [join(root, "src/lib/email/inbound-attachments.ts")],
	outfile: join(directory, "attachments.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => (path in mocks ? { path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
});
const { inboundAttachmentLimitReasonFromRaw } = await import(pathToFileURL(join(directory, "attachments.mjs")).href);

const raw = new ArrayBuffer(8);

test("a mail that can never parse within the limits is still rejected with its reason", async () => {
	globalThis.__parse = async () => { throw new globalThis.__MimeLimitError("Message rejected: EMAXPARTCOUNT."); };
	assert.equal(await inboundAttachmentLimitReasonFromRaw(raw), "Message rejected: EMAXPARTCOUNT.");
});

test("an unexpected parser failure is not turned into a permanent reject", async () => {
	globalThis.__parse = async () => { throw new RangeError("Array buffer allocation failed"); };
	await assert.rejects(inboundAttachmentLimitReasonFromRaw(raw), /allocation failed/);
});

test("a message within the limits passes", async () => {
	globalThis.__parse = async () => ({ attachments: [] });
	assert.equal(await inboundAttachmentLimitReasonFromRaw(raw), null);
});
