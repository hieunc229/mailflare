import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "delegate-access-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, getUserFromSession } from "./src/lib/auth/session.ts";
			export * as contactsRoute from "./src/app/api/contacts/route.ts";
			export { createMailflareMcpHandler } from "./src/lib/mcp/server.ts";
		`,
		resolveDir: root,
		sourcefile: "delegate-access-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, getUserFromSession, contactsRoute, createMailflareMcpHandler } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

// The primary admin owns a shared inbox; Sam is a member of it with the permission each test sets.
async function fixture(t, permission) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, avatar_key, created_at) VALUES
			('primary', 'owner@one.test', 'hash', 'Owner', 'admin', 'avatars/primary', 1),
			('sam', 'sam@one.test', 'hash', 'Sam', 'user', NULL, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'primary', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, use_all_domains, disabled, created_at) VALUES
			('m-owner', 'primary', 'one', 'owner', 'Owner', 'personal', 0, 0, 1),
			('m-sam', 'sam', 'one', 'sam', 'Sam', 'personal', 0, 0, 1),
			('m-shared', 'primary', 'one', 'support', 'Support', 'shared', 0, 0, 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at) VALUES ('default', 'delegate-test', 'team', 'active', '[]', 1);
		INSERT INTO contacts (id, user_id, email, display_name, avatar_key, source, created_at)
			VALUES ('c-owner', 'primary', 'owner@one.test', 'Owner', 'avatars/primary', 'manual', 1);
	`);
	database.db.prepare("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at) VALUES ('grant', 'm-shared', 'sam', ?, 'primary', 1)").run(permission);
	const deleted = [];
	const env = {
		DB: database, MAILFLARE_RUNTIME: "node", APP_URL: "https://mail.test",
		BUCKET: { async delete(keys) { deleted.push(...[keys].flat()); } },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await createSession(env, "sam");
	return {
		sql: database.db,
		env,
		deleted,
		sam: () => getUserFromSession(env, token),
		request: (path, method = "GET") => new Request(`https://mail.test${path}`, {
			method, headers: { Authorization: `Bearer ${token}`, Origin: "https://mail.test" },
		}),
	};
}

test("a shared-inbox manager cannot delete the owner's own contact or its avatar", async t => {
	const f = await fixture(t, "full_access");
	const response = await contactsRoute.DELETE(f.request("/api/contacts?mailboxId=m-shared&address=owner%40one.test", "DELETE"));
	assert.equal(response.status, 403);
	assert.deepEqual(f.deleted, []);
	assert.equal(f.sql.prepare("SELECT count(*) AS count FROM contacts WHERE id='c-owner'").get().count, 1);
});

test("a shared-inbox manager can still delete an ordinary contact", async t => {
	const f = await fixture(t, "full_access");
	f.sql.exec("INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES ('c-friend', 'primary', 'friend@example.net', 'Friend', 'inbound', 1)");
	const response = await contactsRoute.DELETE(f.request("/api/contacts?mailboxId=m-shared&address=friend%40example.net", "DELETE"));
	assert.equal(response.status, 200);
	assert.equal(f.sql.prepare("SELECT count(*) AS count FROM contacts WHERE id='c-friend'").get().count, 0);
});

async function callMcpTool(f, principal, name, args) {
	const handler = createMailflareMcpHandler(f.env, principal, "https://mail.test", "Bearer test");
	try {
		const response = await handler.fetch(new Request("https://mail.test/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		}));
		const text = await response.text();
		const data = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((line) => line.startsWith("data:")).slice(5));
		return data.result;
	} finally {
		await handler.close();
	}
}

function scheduleSend(f) {
	f.sql.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
			VALUES ('scheduled', 'primary', 'm-shared', 'outbound', 'support@one.test', 'customer@example.net', 'Later', 'Body', 'queued', 1);
		INSERT INTO outbound_jobs (id, user_id, message_id, payload, scheduled_at, created_at, updated_at)
			VALUES ('job', 'primary', 'scheduled', '{}', 2000000000, 0, 0);
	`);
}

test("the MCP tool does not let a read-only member cancel a scheduled send", async t => {
	const f = await fixture(t, "read_only");
	scheduleSend(f);
	const principal = { keyId: "key", user: await f.sam(), scopes: ["mcp:draft"], mailboxIds: ["m-shared"] };
	const result = await callMcpTool(f, principal, "cancel_scheduled_send", { mailboxId: "m-shared", messageId: "scheduled" });
	assert.equal(result.isError, true);
	assert.equal(f.sql.prepare("SELECT status FROM messages WHERE id='scheduled'").get().status, "queued");
	assert.equal(f.sql.prepare("SELECT count(*) AS count FROM outbound_jobs").get().count, 1);
});

test("the MCP tool still cancels for a member who can send", async t => {
	const f = await fixture(t, "full_access");
	scheduleSend(f);
	const principal = { keyId: "key", user: await f.sam(), scopes: ["mcp:draft"], mailboxIds: ["m-shared"] };
	const result = await callMcpTool(f, principal, "cancel_scheduled_send", { mailboxId: "m-shared", messageId: "scheduled" });
	assert.notEqual(result.isError, true);
	assert.equal(f.sql.prepare("SELECT status FROM messages WHERE id='scheduled'").get().status, "draft");
});
