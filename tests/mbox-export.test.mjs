import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mbox-export-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		exporter: join(root, "src/lib/export/mbox.ts"),
		importer: join(root, "src/lib/import/mbox.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
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

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { exportMailboxToMbox } = await load("exporter");
const { splitMboxMessages } = await load("importer");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function exportBodies(t, bodies) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	// Only the messages table matters here, so skip creating the user and mailbox rows.
	database.db.pragma("foreign_keys = OFF");
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES (?, 'u1', 'mbx1', 'inbound', 'maya@example.com', 'me@example.com', ?, ?, 'inbox', ?)");
	bodies.forEach((body, index) => insert.run(`msg${index}`, `Message ${index}`, body, 1_790_000_000 + index));
	return exportMailboxToMbox({ DB: database }, "mbx1");
}

test("a body whose first line starts with From is escaped, so the export reads back as one message", async (t) => {
	const mbox = await exportBodies(t, ["From the whole team: thanks!\nSee you soon.", "Second message"]);
	const messages = splitMboxMessages(mbox);
	assert.equal(messages.length, 2);
	assert.doesNotMatch(mbox, /\r\n\r\nFrom the whole team/);
	assert.match(messages[0], /^Message-ID: /);
	assert.match(messages[0], /\n\nFrom the whole team: thanks!\nSee you soon\.$/);
	assert.match(messages[1], /Subject: Message 1/);
});

test("From at the start of a later body line is still escaped", async (t) => {
	const mbox = await exportBodies(t, ["Hello\nFrom here on, reply inline."]);
	assert.match(mbox, /\n>From here on/);
	assert.equal(splitMboxMessages(mbox).length, 1);
});
