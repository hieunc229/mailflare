import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadFixture } from "./helpers/fixtures.mjs";

// The self-host runner applies migrations in file-name order, as wrangler does. Some old migrations (0021, 0041-0050) are not in the
// journal; a journalled one that alters their tables (a later column on booking_events, created by the unjournalled 0049) must not run first.
const fixture = await loadFixture({ name: "migrate-order", entryPoint: "server/runtime/migrate.ts", mocks: {} });
const { applyMigrations } = await fixture.import();
const dir = mkdtempSync(join(tmpdir(), "mailflare-migrate-order-"));
after(() => { rmSync(dir, { recursive: true, force: true }); fixture.dispose(); });

test("a journalled migration that alters a table made by an unjournalled earlier one runs after it", async () => {
	mkdirSync(join(dir, "meta"));
	writeFileSync(join(dir, "0001_base.sql"), "CREATE TABLE t (id text);");
	writeFileSync(join(dir, "0002_unlisted_table.sql"), "CREATE TABLE booking (id text);");
	writeFileSync(join(dir, "0003_alter.sql"), "ALTER TABLE booking ADD COLUMN extra text DEFAULT '[]' NOT NULL;");
	writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: "0001_base" }, { tag: "0003_alter" }] }));
	const db = new DatabaseSync(":memory:");
	const ran = await applyMigrations({ db }, dir);
	assert.deepEqual(ran, ["0001_base.sql", "0002_unlisted_table.sql", "0003_alter.sql"]);
	db.close();
});

test("one that is not in the journal and comes after the last journalled one still runs, last", async () => {
	writeFileSync(join(dir, "0004_hand_written.sql"), "ALTER TABLE booking ADD COLUMN more text;");
	const db = new DatabaseSync(":memory:");
	assert.deepEqual((await applyMigrations({ db }, dir)).at(-1), "0004_hand_written.sql");
	db.close();
});
