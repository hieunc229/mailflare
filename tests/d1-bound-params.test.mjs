import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// D1 rejects a statement with more than 100 bound parameters. A list lookup or
// update that binds one value per id stays under that only while the list is
// short; these cover the sites the first batching pass did not reach.
const D1_MAX_BOUND_PARAMETERS = 100;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-d1-bound-params-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
});
await build({
	entryPoints: {
		followUps: join(root, "src/lib/follow-ups/service.ts"),
		driveAccess: join(root, "src/lib/drive/access.ts"),
		schema: join(root, "src/db/schema/index.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { runFollowUpReminders } = await import(pathToFileURL(join(outDir, "followUps.mjs")).href);
const { toDriveItemDtos } = await import(pathToFileURL(join(outDir, "driveAccess.mjs")).href);
const { driveItems } = await import(pathToFileURL(join(outDir, "schema.mjs")).href);
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);

function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	// Behave like D1: refuse a statement that binds too many parameters.
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...args) => {
			if (args.length > D1_MAX_BOUND_PARAMETERS) throw new Error(`D1_ERROR: too many SQL variables (${args.length} bound): ${sql.slice(0, 160)}`);
			return bind(...args);
		};
		return statement;
	};
	return database;
}

async function migrate(database) {
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('owner', 'owner@example.com', 'Owner', 'x', 'admin', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'owner', 'example.com', 'zone', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES ('mine', 'owner', 'domain', 'owner', 'personal', 0, 0);
	`);
}

/** Sends `count` follow-up-armed messages (epoch-second timestamps), `replies` of them answered later in the thread. */
function insertFollowUps(database, count, { replies = 0 } = {}) {
	const insertMessage = database.db.prepare(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, thread_id, snippet, text_body, html_body, raw_r2_key, created_at)
		VALUES (?, 'owner', 'mine', ?, 'sender@example.com', 'owner@example.com', ?, 1, ?, 'preview', 'b', '<p>b</p>', 'raw', ?)`);
	const insertFollowUp = database.db.prepare(`INSERT INTO follow_ups (id, message_id, user_id, due_at, status, created_at) VALUES (?, ?, 'owner', 1000, 'pending', 0)`);
	for (let index = 0; index < count; index += 1) {
		insertMessage.run(`sent-${index}`, "outbound", "sent", `thread-${index}`, 2000);
		insertFollowUp.run(`fup-${index}`, `sent-${index}`);
	}
	for (let index = 0; index < replies; index += 1) {
		insertMessage.run(`reply-${index}`, "inbound", "received", `thread-${index}`, 3000);
	}
}

function followUpStatuses(database) {
	return new Map(database.db.prepare("SELECT id, status FROM follow_ups").all().map((row) => [row.id, row.status]));
}

test("follow-up cron marks every due reminder when more than a statement's worth are pending", async (t) => {
	const database = fixture(t);
	await migrate(database);
	insertFollowUps(database, 150);
	const env = { DB: database };
	await runFollowUpReminders(env, new Date(2_000_000));
	const statuses = followUpStatuses(database);
	assert.equal(statuses.size, 150);
	assert.ok([...statuses.values()].every((status) => status === "due"));
});

test("follow-up cron closes replied reminders in bulk under the same limit", async (t) => {
	const database = fixture(t);
	await migrate(database);
	insertFollowUps(database, 150, { replies: 150 });
	const env = { DB: database };
	await runFollowUpReminders(env, new Date(2_000_000));
	const statuses = followUpStatuses(database);
	assert.equal(statuses.size, 150);
	assert.ok([...statuses.values()].every((status) => status === "replied"));
});

test("drive items owned by more distinct owners than a statement allows still get DTOs", async (t) => {
	const database = fixture(t);
	await migrate(database);
	const insertUser = database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, 'Owner', 'x', 'user', 0)");
	const insertItem = database.db.prepare(`INSERT INTO drive_items (id, owner_id, parent_id, kind, name, created_at, updated_at)
		VALUES (?, ?, NULL, 'file', ?, 0, 0)`);
	for (let index = 0; index < 150; index += 1) {
		insertUser.run(`user-${index}`, `user${index}@example.com`);
		insertItem.run(`item-${index}`, `user-${index}`, `file-${index}`);
	}
	const { drizzle } = await import("drizzle-orm/d1");
	const db = drizzle(database);
	const rows = await db.select().from(driveItems);
	assert.equal(rows.length, 150);
	const dtos = await toDriveItemDtos(db, rows, "owner");
	assert.equal(dtos.length, 150);
	assert.equal(dtos[0].ownerName, "Owner");
});
