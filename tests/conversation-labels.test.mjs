import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-conversation-labels-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const shared = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
};
await build({
	...shared,
	stdin: {
		contents: `
			export * from "./src/lib/labels/service";
			export { hasLabelId } from "./src/lib/labels/conditions";
			export { conversationForUser } from "./src/lib/notes/service";
			export { buildSearchConditions } from "./src/lib/search/conditions";
			export { messages } from "./src/db/schema";
			export { getDb } from "./src/db";
			export { and, asc } from "drizzle-orm";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(outDir, "labels.mjs"),
});
await build({
	...shared,
	entryPoints: {
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
});

// The real MCP tool handlers run against a recording server, as in conversation-notes.test.mjs.
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
	...shared,
	stdin: { contents: `export { createMailflareMcpHandler } from "./src/lib/mcp/server";`, resolveDir: root, loader: "ts" },
	outfile: join(outDir, "mcp.mjs"),
	plugins: [{
		name: "mcp-mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => (args.path in mcpMocks ? { path: args.path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mcpMocks[args.path], loader: "js" }));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const labels = await load("labels");
const mcp = await load("mcp");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const owner = { id: "owner", role: "user" };
const reader = { id: "reader", role: "user" };

/** A shared mailbox owned by `owner`, with `reader` given read-only access on a Team license. */
async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	const run = (sql, ...params) => database.db.prepare(sql).run(...params);
	for (const [id, name] of [["owner", "Olivia"], ["reader", "Ravi"]]) {
		run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)", id, `${id}@example.com`, name, now);
	}
	run("INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'instance', 'team', 'active', ?) ON CONFLICT (id) DO UPDATE SET plan = 'team', state = 'active'", now);
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'owner', 'example.com', 'zone', ?)", now);
	for (const id of ["support", "sales"]) run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES (?, 'owner', 'd1', ?, 'shared', ?)", id, id, now);
	run("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('ma1', 'support', 'reader', 'read_only', ?)", now);
	const addMessage = (id, threadId = "thread-1", mailboxId = "support") => run(
		"INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES (?, ?, 'owner', 'inbound', 'maya@acme.test', ?, 'Order', 'received', ?, ?)",
		id, mailboxId, `${mailboxId}@example.com`, threadId, now,
	);
	const db = labels.getDb({ DB: database });
	const conversation = async (user, messageId) => {
		const found = await labels.conversationForUser(db, user, messageId);
		assert.ok(found, `${user.id} should read ${messageId}`);
		return found;
	};
	/** Message ids matching `conditions`, the way the list route filters. */
	const matching = async (...conditions) => (await db
		.select({ id: labels.messages.id })
		.from(labels.messages)
		.where(labels.and(...conditions))
		.orderBy(labels.asc(labels.messages.id))).map((row) => row.id);
	return { db, run, addMessage, conversation, matching, env: { DB: database } };
}

test("a label marks the whole conversation, from whichever email, and moves nothing", async (t) => {
	const { db, addMessage, conversation, matching } = await createFixture(t);
	addMessage("m1");
	addMessage("m2");
	addMessage("other", "thread-2");
	const orders = await labels.createLabel(db, "support", { name: "Orders", color: "#16a34a" });
	const urgent = await labels.createLabel(db, "support", { name: "Urgent", color: "#dc2626" });

	assert.equal(await labels.setConversationLabel(db, await conversation(owner, "m1"), orders.id, true), true);
	assert.equal(await labels.setConversationLabel(db, await conversation(owner, "m2"), orders.id, true), true, "applying twice is a no-op");
	await labels.setConversationLabel(db, await conversation(owner, "m2"), urgent.id, true);

	assert.deepEqual((await labels.listConversationLabels(db, await conversation(owner, "m1"))).map((label) => label.name), ["Orders", "Urgent"]);
	const rows = await labels.labelsForRows(db, [
		{ id: "m2", mailboxId: "support", threadId: "thread-1" },
		{ id: "other", mailboxId: "support", threadId: "thread-2" },
	]);
	assert.deepEqual(rows.get("m2").map((label) => label.name), ["Orders", "Urgent"]);
	assert.equal(rows.has("other"), false);
	assert.deepEqual(await matching(labels.hasLabelId(orders.id)), ["m1", "m2"], "the filter keeps every email of the conversation");

	const statuses = await db.select({ status: labels.messages.status, folderId: labels.messages.folderId }).from(labels.messages);
	assert.ok(statuses.every((row) => row.status === "received" && row.folderId === null), "labelling moved nothing");

	await labels.setConversationLabel(db, await conversation(owner, "m1"), orders.id, false);
	assert.deepEqual((await labels.listConversationLabels(db, await conversation(owner, "m2"))).map((label) => label.name), ["Urgent"]);
});

test("search finds a label by name, without regard to case", async (t) => {
	const { db, addMessage, conversation, matching } = await createFixture(t);
	addMessage("m1");
	addMessage("other", "thread-2");
	const label = await labels.createLabel(db, "support", { name: "Orders", color: "#16a34a" });
	await labels.setConversationLabel(db, await conversation(owner, "m1"), label.id, true);
	assert.deepEqual(await matching(...labels.buildSearchConditions("label:orders")), ["m1"]);
	assert.deepEqual(await matching(...labels.buildSearchConditions("label:\"ORDERS\"")), ["m1"]);
	assert.deepEqual(await matching(...labels.buildSearchConditions("label:missing")), []);
});

test("a label of one mailbox matches nothing in another, even on a shared thread key", async (t) => {
	const { db, addMessage, conversation, matching } = await createFixture(t);
	addMessage("in-support", "thread-1", "support");
	addMessage("in-sales", "thread-1", "sales");
	const supportLabel = await labels.createLabel(db, "support", { name: "Orders", color: "#16a34a" });
	const salesLabel = await labels.createLabel(db, "sales", { name: "Orders", color: "#16a34a" });
	assert.ok(salesLabel, "names are unique per mailbox, not per installation");

	assert.equal(await labels.setConversationLabel(db, await conversation(owner, "in-support"), salesLabel.id, true), false, "another mailbox's label is refused");
	await labels.setConversationLabel(db, await conversation(owner, "in-support"), supportLabel.id, true);
	assert.deepEqual(await matching(labels.hasLabelId(supportLabel.id)), ["in-support"]);
	assert.deepEqual(await matching(...labels.buildSearchConditions("label:orders")), ["in-support"]);
});

test("names are unique per mailbox without regard to case; deleting a label takes it off every conversation", async (t) => {
	const { db, addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	const label = await labels.createLabel(db, "support", { name: "Orders", color: "#16a34a" });
	assert.equal(await labels.createLabel(db, "support", { name: "orders", color: "#2563eb" }), null);
	const other = await labels.createLabel(db, "support", { name: "Receipts", color: "#2563eb" });
	assert.equal(await labels.updateLabel(db, other, { name: "ORDERS" }), "duplicate");
	assert.deepEqual(await labels.updateLabel(db, other, { color: "#7c3aed" }), { ...other, color: "#7c3aed" });

	await labels.setConversationLabel(db, await conversation(owner, "m1"), label.id, true);
	await labels.deleteLabel(db, label.id);
	assert.deepEqual(await labels.listConversationLabels(db, await conversation(owner, "m1")), []);
	assert.deepEqual((await labels.listLabels(db, ["support"])).map((item) => item.name), ["Receipts"]);
});

test("applying a label needs more than read-only access, like the star", async (t) => {
	const { addMessage, conversation } = await createFixture(t);
	addMessage("m1");
	assert.equal((await conversation(owner, "m1")).canChange, true);
	assert.equal((await conversation(reader, "m1")).canChange, false);
});

test("an MCP key with only mcp:read can see labels but cannot change them", async (t) => {
	const { db, addMessage, conversation, env } = await createFixture(t);
	addMessage("m1");
	const label = await labels.createLabel(db, "support", { name: "Orders", color: "#16a34a" });
	await labels.setConversationLabel(db, await conversation(owner, "m1"), label.id, true);
	const call = async (principal, name, args) => {
		const server = mcp.createMailflareMcpHandler(env, principal, "http://localhost", "");
		const result = await server.tools.get(name)(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};
	const readKey = { keyId: "key", user: owner, scopes: ["mcp:read"], mailboxIds: ["support"] };

	const all = await call(readKey, "list_labels", { mailboxId: "support" });
	assert.deepEqual(all.data.labels.map((item) => item.name), ["Orders"]);
	const onConversation = await call(readKey, "list_labels", { mailboxId: "support", messageId: "m1" });
	assert.deepEqual(onConversation.data.labels.map((item) => item.name), ["Orders"]);

	const denied = await call(readKey, "set_conversation_label", { mailboxId: "support", messageId: "m1", labelId: label.id, applied: false });
	assert.equal(denied.isError, true);
	assert.equal(denied.data.error, "Permission denied");

	const organizeKey = { ...readKey, scopes: ["mcp:read", "mcp:organize"] };
	const removed = await call(organizeKey, "set_conversation_label", { mailboxId: "support", messageId: "m1", labelId: label.id, applied: false });
	assert.equal(removed.isError, false);
	assert.deepEqual(removed.data.labels, []);

	const readOnlyMember = { keyId: "key2", user: reader, scopes: ["mcp:read", "mcp:organize"], mailboxIds: ["support"] };
	const refused = await call(readOnlyMember, "set_conversation_label", { mailboxId: "support", messageId: "m1", labelId: label.id, applied: true });
	assert.equal(refused.isError, true, "the key cannot do more than its user's mailbox permission");
});
