import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-conversation-notes-"));
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

// The real tool handlers of src/lib/mcp/server.ts run against a recording MCP
// server and stubs for everything outside the note tools, so the scope checks
// execute exactly as shipped without a JSON-RPC transport.
const mcpMocks = {
	"@modelcontextprotocol/server": `
		export class McpServer {
			constructor() { this.tools = new Map(); }
			registerTool(name, config, handler) { this.tools.set(name, handler); }
		}
		export const createMcpHandler = (factory) => factory();
	`,
	"@/lib/agent/tools": `export const EMAIL_TOOL_NAMES = []; export const emailToolDescriptions = { edit_draft: "" }; export const emailToolSchemas = { edit_draft: { shape: {} } }; export const runEmailTool = () => { throw new Error("not under test"); };`,
	"@/lib/agent/edit-draft": `export const editAgentDraft = () => { throw new Error("not under test"); };`,
	"@/lib/agent/approvals/utils": `export const requestAgentSend = () => { throw new Error("not under test"); }; export const getAgentSendRequest = () => { throw new Error("not under test"); };`,
	"@/lib/email/scheduled": `export const cancelScheduledSend = () => { throw new Error("not under test"); }; export const getScheduledTime = () => { throw new Error("not under test"); };`,
	"@/lib/calendar/tools": `export const CALENDAR_TOOL_NAMES = []; export const calendarToolDescriptions = {}; export const calendarToolSchemas = {}; export const calendarToolScope = () => "mcp:calendar-read"; export const runCalendarTool = () => { throw new Error("not under test"); };`,
	"./admin-tools": `export const registerAdminMcpTools = () => {};`,
};
await build({
	stdin: {
		contents: `export { createMailflareMcpHandler } from "./src/lib/mcp/server";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "mcp.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
	plugins: [{
		name: "mcp-mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => (args.path in mcpMocks ? { path: args.path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mcpMocks[args.path], loader: "js" }));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const notes = await load("notes");
const mcp = await load("mcp");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const owner = { id: "owner", role: "user" };
const reader = { id: "reader", role: "user" };
const stranger = { id: "stranger", role: "user" };

/** A shared mailbox owned by `owner`, with `reader` given read-only access on a Team license. */
async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	const run = (sql, ...params) => database.db.prepare(sql).run(...params);
	for (const [id, name] of [["owner", "Olivia"], ["reader", "Ravi"], ["stranger", "Sam"]]) {
		run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)", id, `${id}@example.com`, name, now);
	}
	run("INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'instance', 'team', 'active', ?) ON CONFLICT (id) DO UPDATE SET plan = 'team', state = 'active'", now);
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'owner', 'example.com', 'zone', ?)", now);
	run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('support', 'owner', 'd1', 'support', 'shared', ?)", now);
	run("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('ma1', 'support', 'reader', 'read_only', ?)", now);
	const addMailbox = (id) => run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES (?, 'owner', 'd1', ?, 'shared', ?)", id, id, now);
	const addMessage = (id, threadId = "thread-1", mailboxId = "support") => run(
		"INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES (?, ?, 'owner', 'inbound', 'maya@acme.test', ?, 'Help', 'received', ?, ?)",
		id, mailboxId, `${mailboxId}@example.com`, threadId, now,
	);
	const db = notes.getDb({ DB: database });
	const conversation = async (user, messageId) => {
		const found = await notes.conversationForUser(db, user, messageId);
		assert.ok(found, `${user.id} should read ${messageId}`);
		return found;
	};
	return { db, run, addMailbox, addMessage, conversation, env: { DB: database } };
}

test("only the author edits a note; the author or a mailbox manager deletes it", () => {
	assert.equal(notes.canEditNote("a", "a"), true);
	assert.equal(notes.canEditNote("a", "b"), false);
	assert.equal(notes.canEditNote(null, "a"), false);
	assert.equal(notes.canDeleteNote("a", "a", false), true);
	assert.equal(notes.canDeleteNote("a", "b", false), false);
	assert.equal(notes.canDeleteNote("a", "b", true), true);
	assert.equal(notes.canDeleteNote(null, "b", true), true);
	assert.equal(notes.canDeleteNote(null, "b", false), false);
});

test("a conversation keeps every note, oldest first, whichever email it is opened from", async (t) => {
	const { db, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	addMessage("m2");
	addMessage("other", "thread-2");
	const fromFirst = await conversation(owner, "m1");
	const first = await notes.addConversationNote(db, fromFirst, owner.id, { html: "<p>Checked the date</p>" });
	const second = await notes.addConversationNote(db, await conversation(reader, "m2"), reader.id, { html: "<p>Spare part ships Friday</p>", attachToMessage: true });

	const listed = await notes.listConversationNotes(db, await conversation(owner, "m2"), owner.id);
	assert.deepEqual(listed.map((note) => note.id), [first.id, second.id]);
	assert.deepEqual(listed.map((note) => note.authorName), ["Olivia", "Ravi"]);
	assert.equal(listed[0].messageId, null, "a note from the toolbar is about the whole conversation");
	assert.equal(listed[1].messageId, "m2", "a note added from an email's menu is about that email");
	assert.deepEqual(await notes.listConversationNotes(db, await conversation(owner, "other"), owner.id), []);
});

test("a message outside any thread is its own conversation", async (t) => {
	const { db, run, conversation } = await createFixture(t);
	run("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('alone', 'support', 'owner', 'inbound', 'a@b.test', 'support@example.com', 'Hi', 'received', ?)", seconds(new Date()));
	const alone = await conversation(owner, "alone");
	assert.equal(alone.threadKey, "alone");
	await notes.addConversationNote(db, alone, owner.id, { html: "<p>x</p>" });
	assert.equal((await notes.listConversationNotes(db, alone, owner.id)).length, 1);
});

test("notes on a self-keyed email survive its thread_id being set on send", async (t) => {
	const { db, run, conversation } = await createFixture(t);
	run("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('queued', 'support', 'owner', 'outbound', 'support@example.com', 'sam@acme.test', 'Hi', 'queued', ?)", seconds(new Date()));
	const before = await conversation(owner, "queued");
	assert.equal(before.threadKey, "queued");
	const note = await notes.addConversationNote(db, before, owner.id, { html: "<p>draft note</p>" });

	// send.ts rewrites thread_id once the provider Message-ID is known.
	run("UPDATE messages SET thread_id = 'provider-key' WHERE id = 'queued'");
	const after = await conversation(owner, "queued");
	assert.equal(after.threadKey, "provider-key");
	assert.deepEqual((await notes.listConversationNotes(db, after, owner.id)).map((n) => n.id), [note.id]);

	// A reply joins under the provider key; the note must still be found from it.
	run("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES ('reply', 'support', 'owner', 'inbound', 'sam@acme.test', 'support@example.com', 'Re: Hi', 'received', 'provider-key', ?)", seconds(new Date()));
	const fromReply = await conversation(owner, "reply");
	assert.deepEqual((await notes.listConversationNotes(db, fromReply, owner.id)).map((n) => n.id), [note.id]);
	assert.equal((await notes.updateConversationNote(db, fromReply, owner.id, note.id, "<p>still reachable</p>")).ok, true);
	assert.deepEqual(await notes.deleteConversationNote(db, fromReply, owner.id, note.id), { ok: true });
});

test("a read-only member can write notes but cannot change or delete someone else's", async (t) => {
	const { db, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	const asOwner = await conversation(owner, "m1");
	const asReader = await conversation(reader, "m1");
	assert.equal(asReader.canManage, false);
	const ownerNote = await notes.addConversationNote(db, asOwner, owner.id, { html: "<p>owner</p>" });
	const readerNote = await notes.addConversationNote(db, asReader, reader.id, { html: "<p>reader</p>" });

	const seenByReader = await notes.listConversationNotes(db, asReader, reader.id);
	assert.deepEqual(seenByReader.map((note) => [note.canEdit, note.canDelete]), [[false, false], [true, true]]);
	assert.deepEqual(await notes.updateConversationNote(db, asReader, reader.id, ownerNote.id, "<p>rewritten</p>"), { ok: false, error: "forbidden" });
	assert.deepEqual(await notes.deleteConversationNote(db, asReader, reader.id, ownerNote.id), { ok: false, error: "forbidden" });

	const edited = await notes.updateConversationNote(db, asReader, reader.id, readerNote.id, "<p>reader, edited</p>");
	assert.equal(edited.ok, true);
	assert.equal(edited.note.html, "<p>reader, edited</p>");
	assert.equal(edited.note.authorName, "Ravi");

	assert.deepEqual(await notes.deleteConversationNote(db, asReader, reader.id, readerNote.id), { ok: true });
	assert.deepEqual((await notes.listConversationNotes(db, asReader, reader.id)).map((note) => note.id), [ownerNote.id]);
});

test("the mailbox owner may delete a member's note but not rewrite it", async (t) => {
	const { db, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	const asOwner = await conversation(owner, "m1");
	const readerNote = await notes.addConversationNote(db, await conversation(reader, "m1"), reader.id, { html: "<p>reader</p>" });
	assert.deepEqual(await notes.updateConversationNote(db, asOwner, owner.id, readerNote.id, "<p>owner words</p>"), { ok: false, error: "forbidden" });
	assert.deepEqual(await notes.deleteConversationNote(db, asOwner, owner.id, readerNote.id), { ok: true });
	assert.deepEqual(await notes.listConversationNotes(db, asOwner, owner.id), []);
});

test("an edit made in the same second still lands after created_at", async (t) => {
	const { db, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	const conv = await conversation(owner, "m1");
	const note = await notes.addConversationNote(db, conv, owner.id, { html: "<p>x</p>" });
	const edited = await notes.updateConversationNote(db, conv, owner.id, note.id, "<p>y</p>");
	assert.equal(edited.ok, true);
	assert.ok(Date.parse(edited.note.updatedAt) > Date.parse(edited.note.createdAt));
});

test("a note id from another conversation or mailbox is not found there", async (t) => {
	const { db, addMailbox, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	addMessage("other", "thread-2");
	addMailbox("billing");
	addMessage("bm1", "billing-thread", "billing");
	const note = await notes.addConversationNote(db, await conversation(owner, "m1"), owner.id, { html: "<p>x</p>" });
	for (const elsewhere of [await conversation(owner, "other"), await conversation(owner, "bm1")]) {
		assert.deepEqual(await notes.updateConversationNote(db, elsewhere, owner.id, note.id, "<p>y</p>"), { ok: false, error: "not_found" });
		assert.deepEqual(await notes.deleteConversationNote(db, elsewhere, owner.id, note.id), { ok: false, error: "not_found" });
		assert.deepEqual(await notes.listConversationNotes(db, elsewhere, owner.id), []);
	}
	const [kept] = await notes.listConversationNotes(db, await conversation(owner, "m1"), owner.id);
	assert.equal(kept.html, "<p>x</p>", "the rejected calls did not touch the note");
});

test("someone without access to the mailbox gets no conversation", async (t) => {
	const { db, addMessage } = await createFixture(t);
	addMessage("m1");
	assert.equal(await notes.conversationForUser(db, stranger, "m1"), null);
	assert.equal(await notes.conversationForUser(db, owner, "missing"), null);
});

test("deleting the email a note is about keeps the note for the conversation", async (t) => {
	const { db, run, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	addMessage("m2");
	await notes.addConversationNote(db, await conversation(owner, "m2"), owner.id, { html: "<p>about m2</p>", attachToMessage: true });
	run("DELETE FROM messages WHERE id = 'm2'");
	const [note] = await notes.listConversationNotes(db, await conversation(owner, "m1"), owner.id);
	assert.equal(note.messageId, null);
});

test("a note whose author is gone stays, can no longer be edited, and a manager can delete it", async (t) => {
	const { db, run, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	await notes.addConversationNote(db, await conversation(reader, "m1"), reader.id, { html: "<p>from Ravi</p>" });
	run("DELETE FROM mailbox_access WHERE user_id = 'reader'");
	run("DELETE FROM users WHERE id = 'reader'");
	const asOwner = await conversation(owner, "m1");
	const [note] = await notes.listConversationNotes(db, asOwner, owner.id);
	assert.equal(note.authorName, null);
	assert.equal(note.canEdit, false);
	assert.equal(note.canDelete, true);
});

test("an MCP key with only mcp:read can list notes but cannot write them", async (t) => {
	const { db, addMessage, conversation, env } = await createFixture(t);
	addMessage("m1");
	const own = await conversation(owner, "m1");
	const note = await notes.addConversationNote(db, own, owner.id, { html: "<p>x</p>" });
	const server = mcp.createMailflareMcpHandler(env, { keyId: "key", user: reader, scopes: ["mcp:read"], mailboxIds: ["support"] }, "http://localhost", "");
	const call = async (name, args) => {
		const result = await server.tools.get(name)(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};

	const listed = await call("list_conversation_notes", { mailboxId: "support", messageId: "m1" });
	assert.equal(listed.isError, false);
	assert.equal(listed.data.contentTrust, "untrusted_third_party_content");
	assert.equal(listed.data.notes.length, 1);

	for (const [name, args] of [
		["add_conversation_note", { mailboxId: "support", messageId: "m1", html: "<p>denied</p>" }],
		["update_conversation_note", { mailboxId: "support", messageId: "m1", noteId: note.id, html: "<p>denied</p>" }],
		["delete_conversation_note", { mailboxId: "support", messageId: "m1", noteId: note.id }],
	]) {
		const denied = await call(name, args);
		assert.equal(denied.isError, true);
		assert.equal(denied.data.error, "Permission denied");
	}
	const [kept] = await notes.listConversationNotes(db, own, owner.id);
	assert.equal(kept.html, "<p>x</p>", "the denied calls did not touch the note");
});
