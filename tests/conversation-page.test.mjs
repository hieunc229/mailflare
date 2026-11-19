import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { sql } from "drizzle-orm";
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

// All inboxes lists every mailbox, so the filter names no mailbox.
const everyMailbox = sql`status = ${"received"}`;

test("one thread delivered to two mailboxes is one conversation per mailbox", async (t) => {
	const fixture = createConversationFixture(SqliteDatabase, [
		at(100, "mine-copy", "shared-thread", "mine"),
		at(200, "theirs-copy", "shared-thread", "theirs"),
		at(300, "mine-reply", "shared-thread", "mine"),
	], everyMailbox);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 0, limit: 25 });

	assert.deepEqual(page, { ids: ["mine-reply", "theirs-copy"], total: 2 });
});

test("the windowed plan also keeps each mailbox's copy of a thread apart", async (t) => {
	const filler = Array.from({ length: 10000 }, (_, index) => at(1000 + index, `m${String(index).padStart(5, "0")}`));
	const fixture = createConversationFixture(SqliteDatabase, [
		...filler,
		at(1, "mine-copy", "shared-thread", "mine"),
		at(2, "theirs-copy", "shared-thread", "theirs"),
	], everyMailbox);
	t.after(() => fixture.database.db.close());
	// offset + limit is past the scan cap, so this takes the windowed plan.
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 10000, limit: 25 });

	assert.equal(fixture.queryCount(), 2);
	assert.deepEqual(page, { ids: ["theirs-copy", "mine-copy"], total: 10002 });
});

test("rows without a mailbox still group by thread among themselves", async (t) => {
	const fixture = createConversationFixture(SqliteDatabase, [
		at(100, "orphan-a", "orphan-thread", null),
		at(200, "orphan-b", "orphan-thread", null),
		at(300, "orphan-c", "other-thread", null),
	], everyMailbox);
	t.after(() => fixture.database.db.close());
	const page = await loadConversationPage({ db: fixture.db, where: fixture.where, offset: 0, limit: 25 });

	assert.deepEqual(page, { ids: ["orphan-c", "orphan-b"], total: 2 });
});
