import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-mcp-mail-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createMailflareMcpHandler } from "./src/lib/mcp/server.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
			export { parseSnoozeUntil } from "./src/lib/mcp/mail-tools-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "mcp-mail-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createMailflareMcpHandler, runEmailTool, parseSnoozeUntil } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const FUTURE = 4_000_000_000; // 2096, in seconds

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1), ('mailbox-2', 'user-1', 'domain-1', 'other', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('folder-1', 'user-1', 'mailbox-1', 'Receipts', 1), ('folder-2', 'user-1', 'mailbox-2', 'Elsewhere', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('email-1', 'user-1', 'mailbox-1', 'inbound', 'Ada <ada@example.net>', 'owner@example.com', 'Invoice', 'Your invoice', 'received', 3),
			('email-2', 'user-1', 'mailbox-1', 'inbound', 'grace@example.net', 'owner@example.com', 'Lunch', 'Lunch?', 'received', 2),
			('email-3', 'user-1', 'mailbox-2', 'inbound', 'linus@example.org', 'other@example.com', 'Private', 'Other mailbox', 'received', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, last_seen_at, created_at) VALUES
			('contact-1', 'user-1', 'ada@example.net', 'Ada Lovelace', 'inbound', 3, 1),
			('contact-2', 'user-1', 'linus@example.org', 'Linus', 'inbound', 1, 1);
	`);
	const env = { DB: database, BUCKET: { get: async () => null, delete: async () => {} } };
	const user = { id: "user-1", email: "owner@example.com", role: "user" };
	const principal = { keyId: "key-1", user, scopes: ["mcp:read", "mcp:organize", "mcp:draft"], mailboxIds: ["mailbox-1"] };
	let nextId = 1;
	async function rpc(method, params = {}, who = principal) {
		const handler = createMailflareMcpHandler(env, who, "http://mailflare.local", "Bearer test");
		const call = (body) => handler.fetch(new Request("http://mailflare.local/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify(body) }));
		try {
			await call({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
			const response = await call({ jsonrpc: "2.0", id: nextId++, method, params });
			const text = await response.text();
			const body = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:")).slice(5) : text);
			return body;
		} finally { await handler.close(); }
	}
	const tool = async (name, args, who) => {
		const body = await rpc("tools/call", { name, arguments: args }, who);
		assert.ok(body.result, JSON.stringify(body));
		return { ...JSON.parse(body.result.content[0].text), isError: body.result.isError };
	};
	return { database, env, user, principal, rpc, tool };
}

test("the MCP server lists the folder, star, snooze, folder-move and contact tools with its package version", async (t) => {
	const { rpc } = await fixture(t);
	const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	assert.equal(initialized.result.serverInfo.version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
	const listed = await rpc("tools/list");
	const names = listed.result.tools.map((entry) => entry.name);
	for (const name of ["list_folders", "star_email", "snooze_email", "move_to_folder", "search_contacts", "list_emails", "move_email"]) assert.ok(names.includes(name), name);
	const listFolders = listed.result.tools.find((entry) => entry.name === "list_folders");
	assert.equal(listFolders.annotations.readOnlyHint, true);
});

test("list_folders, star_email and move_to_folder stay inside the key's mailboxes", async (t) => {
	const { database, tool } = await fixture(t);
	const listed = await tool("list_folders", { mailboxId: "mailbox-1" });
	assert.deepEqual(listed.folders.map((folder) => folder.id), ["folder-1"]);
	assert.equal((await tool("list_folders", { mailboxId: "mailbox-2" })).isError, true);

	await tool("star_email", { mailboxId: "mailbox-1", emailId: "email-1", starred: true });
	assert.equal(database.db.prepare("SELECT starred FROM messages WHERE id = 'email-1'").get().starred, 1);
	assert.equal((await tool("star_email", { mailboxId: "mailbox-1", emailId: "email-3", starred: true })).isError, true);
	const starred = await tool("list_emails", { mailboxId: "mailbox-1", folder: "starred" });
	assert.deepEqual(starred.emails.map((email) => email.id), ["email-1"]);

	assert.equal((await tool("move_to_folder", { mailboxId: "mailbox-1", emailIds: ["email-1"], folderId: "folder-2" })).isError, true);
	await tool("move_to_folder", { mailboxId: "mailbox-1", emailIds: ["email-1"], folderId: "folder-1" });
	assert.equal(database.db.prepare("SELECT folder_id FROM messages WHERE id = 'email-1'").get().folder_id, "folder-1");
	const inFolder = await tool("list_emails", { mailboxId: "mailbox-1", folderId: "folder-1" });
	assert.deepEqual(inFolder.emails.map((email) => email.id), ["email-1"]);
	const inbox = await tool("list_emails", { mailboxId: "mailbox-1", folder: "inbox" });
	assert.deepEqual(inbox.emails.map((email) => email.id), ["email-2"]);
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM audit_logs WHERE message_id = 'email-1'").get().count, 1);
});

test("move_email to inbox brings a message out of its custom folder and its snooze", async (t) => {
	const { database, env, user } = await fixture(t);
	database.db.exec(`UPDATE messages SET status = 'archived', folder_id = 'folder-1' WHERE id = 'email-1'; UPDATE messages SET snoozed_until = ${FUTURE} WHERE id = 'email-2'`);
	const context = { env, user, mailboxId: "mailbox-1", origin: "mcp" };
	await runEmailTool(context, "move_emails", { emailIds: ["email-1", "email-2"], destination: "inbox" });
	const rows = database.db.prepare("SELECT id, status, folder_id, snoozed_until FROM messages WHERE id IN ('email-1', 'email-2') ORDER BY id").all();
	assert.deepEqual(rows.map((row) => [row.id, row.status, row.folder_id, row.snoozed_until]), [["email-1", "received", null, null], ["email-2", "received", null, null]]);
});

test("snooze_email hides mail from inbox until the time it names, and requires an offset", async (t) => {
	const { database, tool } = await fixture(t);
	assert.equal((await tool("snooze_email", { mailboxId: "mailbox-1", emailId: "email-2", until: "2096-01-01T09:00:00" })).isError, true);
	assert.equal((await tool("snooze_email", { mailboxId: "mailbox-1", emailId: "email-2", until: "2001-01-01T09:00:00Z" })).isError, true);
	const snoozed = await tool("snooze_email", { mailboxId: "mailbox-1", emailId: "email-2", until: "2096-01-01T09:00:00+02:00" });
	assert.equal(snoozed.snoozedUntil, "2096-01-01T07:00:00.000Z");
	const inbox = await tool("list_emails", { mailboxId: "mailbox-1", folder: "inbox" });
	assert.deepEqual(inbox.emails.map((email) => email.id), ["email-1"]);
	const later = await tool("list_emails", { mailboxId: "mailbox-1", folder: "snoozed" });
	assert.deepEqual(later.emails.map((email) => email.id), ["email-2"]);
	await tool("snooze_email", { mailboxId: "mailbox-1", emailId: "email-2", until: null });
	assert.equal(database.db.prepare("SELECT snoozed_until FROM messages WHERE id = 'email-2'").get().snoozed_until, null);
});

test("search_contacts only returns people seen in the key's mailboxes", async (t) => {
	const { tool, principal } = await fixture(t);
	assert.deepEqual((await tool("search_contacts", { query: "ada" })).contacts.map((contact) => contact.email), ["ada@example.net"]);
	assert.deepEqual((await tool("search_contacts", { query: "LOVELACE" })).contacts.map((contact) => contact.email), ["ada@example.net"]);
	assert.deepEqual((await tool("search_contacts", { query: "linus" })).contacts, []);
	const wider = { ...principal, mailboxIds: ["mailbox-1", "mailbox-2"] };
	assert.deepEqual((await tool("search_contacts", { query: "linus" }, wider)).contacts.map((contact) => contact.email), ["linus@example.org"]);
});

test("organize tools refuse a key without the organize scope", async (t) => {
	const { tool, principal } = await fixture(t);
	const readOnly = { ...principal, scopes: ["mcp:read"] };
	const denied = await tool("star_email", { mailboxId: "mailbox-1", emailId: "email-1", starred: true }, readOnly);
	assert.equal(denied.isError, true);
	assert.equal(denied.error, "Permission denied");
});

test("parseSnoozeUntil accepts only future times with an explicit offset", () => {
	const now = new Date("2026-10-31T12:00:00Z");
	assert.equal(parseSnoozeUntil("2026-11-01T09:00:00Z", now)?.toISOString(), "2026-11-01T09:00:00.000Z");
	assert.equal(parseSnoozeUntil("2026-11-01T09:00:00-0500", now)?.toISOString(), "2026-11-01T14:00:00.000Z");
	assert.equal(parseSnoozeUntil("2026-11-01T09:00:00", now), undefined);
	assert.equal(parseSnoozeUntil("2026-10-30T09:00:00Z", now), undefined);
	assert.equal(parseSnoozeUntil("tomorrow Z", now), undefined);
});
