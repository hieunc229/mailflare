import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-reply-thread-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/threading.ts")],
	outfile: join(outDir, "threading.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { resolveDraftThreadId } = await import(pathToFileURL(join(outDir, "threading.mjs")).href);

/** Answers the parent lookup with `rows` and counts the queries. */
function fakeDb(rows) {
	const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows };
	const db = { queries: 0, select: () => (db.queries++, chain) };
	return db;
}

test("a reply from a JMAP client joins its parent's conversation", async () => {
	const db = fakeDb([{ threadId: "parent-thread", providerMessageId: "<parent@example.com>" }]);
	assert.equal(await resolveDraftThreadId(db, "mbx1", "parent@example.com", "root@example.com parent@example.com"), "parent-thread");
});

test("References alone are enough to find the conversation", async () => {
	const db = fakeDb([{ threadId: "parent-thread", providerMessageId: "parent@example.com" }]);
	assert.equal(await resolveDraftThreadId(db, "mbx1", null, "parent@example.com"), "parent-thread");
});

test("a new message has no thread until it is sent and costs no query", async () => {
	const db = fakeDb([]);
	assert.equal(await resolveDraftThreadId(db, "mbx1", null, null), null);
	assert.equal(db.queries, 0);
});

test("a reply to a message that is not stored starts its own thread", async () => {
	const id = await resolveDraftThreadId(fakeDb([]), "mbx1", "gone@example.com", null);
	assert.match(id, /^thr/);
});
