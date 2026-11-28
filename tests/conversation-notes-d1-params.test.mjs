import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-conversation-notes-d1-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export * from "./src/lib/notes/service";
			export * from "./src/lib/notes/note-permissions";
			export { getDb } from "./src/db";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "notes.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
await build({
	entryPoints: {
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
const notes = await load("notes");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const LIMIT = 100;
const owner = { id: "owner", role: "user" };

async function createFixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const run = (sql, ...params) => database.db.prepare(sql).run(...params);
	run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('owner', 'owner@example.com', 'Olivia', 'x', 1)");
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'owner', 'example.com', 'zone', 1)");
	run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('support', 'owner', 'd1', 'support', 'personal', 1)");
	for (let i = 0; i < 150; i += 1) {
		run("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES (?, 'support', 'owner', 'inbound', 'a@acme.test', 'support@example.com', 'Help', 'received', 't1', 1)", `m${i}`);
	}
	const db = notes.getDb({ DB: database });
	const conversation = await notes.conversationForUser(db, owner, "m0");
	assert.ok(conversation);
	assert.ok(conversation.threadKeys.length > LIMIT);
	// Behave like D1: refuse a statement that binds too many parameters.
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		function wrap(statement) {
			const bind = statement.bind.bind(statement);
			statement.bind = (...args) => {
				if (args.length > LIMIT) throw new Error(`D1_ERROR: too many SQL variables (${args.length} bound)`);
				return wrap(bind(...args));
			};
			return statement;
		}
		return wrap(prepare(sql));
	};
	return { db, conversation };
}

async function addThree(db, conversation) {
	const added = [];
	for (const id of ["m0", "m120", "m149"]) {
		added.push(await notes.addConversationNote(db, { ...conversation, messageId: id }, "owner", { html: `<p>${id}</p>` }));
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return added;
}

test("listing notes in a 150-message thread stays under the D1 parameter limit", async (t) => {
	const { db, conversation } = await createFixture(t);
	const added = await addThree(db, conversation);
	const listed = await notes.listConversationNotes(db, conversation, "owner");
	assert.deepEqual(listed.map((n) => n.id), added.map((n) => n.id).sort());
});

test("a note can still be edited, deleted and its author's avatar looked up in a long thread", async (t) => {
	const { db, conversation } = await createFixture(t);
	const added = await addThree(db, conversation);
	const edited = await notes.updateConversationNote(db, conversation, "owner", added[2].id, "<p>x</p>");
	assert.equal(edited.ok, true);
	assert.equal(await notes.noteAuthorAvatarKey(db, conversation, "owner"), null);
	assert.deepEqual(await notes.deleteConversationNote(db, conversation, "owner", added[2].id), { ok: true });
});
