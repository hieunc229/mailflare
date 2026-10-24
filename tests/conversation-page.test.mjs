import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { at, createConversationFixture } from "./conversation-page-utils.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-conversation-page-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		page: join(root, "src/app/api/messages/utils.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const { loadConversationPage } = await import(pathToFileURL(join(outDir, "page.mjs")).href);
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);

test("deep conversation pages use two queries and report the real total", async (t) => {
	const rows = Array.from({ length: 15000 }, (_, index) => at(index, `m${String(index).padStart(5, "0")}`));
	const fixture = createConversationFixture(SqliteDatabase, rows);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 12500, limit: 25 });

	assert.equal(fixture.queryCount(), 2);
	assert.equal(page.total, 15000);
	assert.equal(page.ids.length, 25);
	assert.equal(page.ids[0], "m02499");
	assert.equal(page.ids.at(-1), "m02475");
});

test("a long conversation does not consume one query per batch of messages", async (t) => {
	const rows = Array.from({ length: 15000 }, (_, index) => at(index, `m${String(index).padStart(5, "0")}`, "long-thread"));
	const fixture = createConversationFixture(SqliteDatabase, rows);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 0, limit: 25 });

	assert.ok(fixture.queryCount() <= 4);
	assert.equal(page.total, 1);
	assert.deepEqual(page.ids, ["m14999"]);
});

test("equal timestamps select one head per thread before applying the offset", async (t) => {
	const fixture = createConversationFixture(SqliteDatabase, [
		at(100, "a", "same-thread"),
		at(100, "c", "same-thread"),
		at(100, "b", null),
	]);
	t.after(() => fixture.database.db.close());
	const first = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 0, limit: 1 });
	const second = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 1, limit: 1 });

	assert.deepEqual(first, { ids: ["c"], total: 2 });
	assert.deepEqual(second, { ids: ["b"], total: 2 });
});

test("counts and conversation heads share mailbox and status filters", async (t) => {
	const fixture = createConversationFixture(SqliteDatabase, [
		at(100, "visible", "shared-thread"),
		at(200, "other-mailbox", "shared-thread", "theirs"),
		at(300, "archived", "shared-thread", "mine", "archived"),
		at(400, "hidden-thread", "hidden", "theirs"),
	]);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 0, limit: 25 });

	assert.deepEqual(page, { ids: ["visible"], total: 1 });
});

test("an offset past the end returns no heads and retains the real total", async (t) => {
	const fixture = createConversationFixture(SqliteDatabase, [at(1, "only-message")]);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 50, limit: 25 });

	assert.equal(fixture.queryCount(), 2);
	assert.deepEqual(page, { ids: [], total: 1 });
});
