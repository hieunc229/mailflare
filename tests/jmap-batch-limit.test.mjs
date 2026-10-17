import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * D1 caps bound parameters per query at 100, but `Email/get` legally serves
 * up to 200 ids (LIMITS.maxObjectsInGet), so `loadMessages`,
 * `threadGet`, and `loadAttachmentsByMessage` fetch in batches. These tests
 * pin the observable contract across batch boundaries — every id answered
 * once, no duplicated rows or attachments — plus the rule that a serverFail
 * description never echoes SQL internals to the client. Everything runs
 * against an in-memory SQLite database; no Workers binding is touched.
 */
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-batch-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { emailGet, loadMessages, threadGet } from "./src/lib/jmap/emails.ts";
			export { loadAttachmentsByMessage } from "./src/lib/jmap/email-objects.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-batch-test-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { SqliteDatabase, applyMigrations, getDb, emailGet, loadMessages, threadGet, loadAttachmentsByMessage, processRequest } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const MAILBOX = "mbx_test";
async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	await applyMigrations(database, join(root, "drizzle/migrations"));
	t.after(() => database.db.close());
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES
			('${MAILBOX}', 'admin', 'one', 'support', 'Support', 1, 'personal', 0, 1);
	`);
	const env = { DB: database };
	const ctx = {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
	return { database, ctx };
}

const ids = (count) => Array.from({ length: count }, (_, i) => `msg_${String(i).padStart(4, "0")}`);

function seedMessages(database, idList) {
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, starred, created_at)
		VALUES ${idList.map((id) => `('${id}', 'admin', '${MAILBOX}', 'inbound', 'a@one.test', 'support@one.test', 'received', 0, 0, 2)`).join(", ")};
	`);
}

test("Email/get returns every row across batch boundaries without duplicates", async (t) => {
	const { database, ctx } = await fixture(t);
	seedMessages(database, ids(160));
	const requested = [...ids(160), "msg_0000", "msg_0001"];

	const result = await emailGet(ctx, { ids: requested, properties: ["keywords"] });
	assert.equal(result.list.length, 160, "each requested id appears exactly once");
	assert.deepEqual(result.notFound, []);
});

test("loadMessages preserves the single-query contract for repeated ids", async (t) => {
	const { database, ctx } = await fixture(t);
	seedMessages(database, ids(120));
	const rows = await loadMessages(ctx, [...ids(120), "msg_0000"]);
	assert.equal(rows.length, 120, "duplicate ids do not duplicate rows");
});

test("Thread/get groups every thread across batches", async (t) => {
	const { database, ctx } = await fixture(t);
	seedMessages(database, ids(150));
	const requested = [...ids(150), "msg_0000"];

	const result = await threadGet(ctx, { ids: requested });
	assert.equal(result.list.length, 150, "one group per unique thread id");
	assert.deepEqual(result.notFound, []);
	assert.ok(result.list.every((group) => group.emailIds.length === 1));
});

test("attachment loading survives more than 100 message ids", async (t) => {
	const { database, ctx } = await fixture(t);
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, starred, created_at)
		VALUES ('msg_a', 'admin', '${MAILBOX}', 'inbound', 'a@one.test', 'support@one.test', 'received', 0, 0, 2),
		       ('msg_b', 'admin', '${MAILBOX}', 'inbound', 'a@one.test', 'support@one.test', 'received', 0, 0, 2);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at)
		VALUES ('att_1', 'msg_a', 'a.txt', 'text/plain', 3, 'attachment', 'r2_1', 2),
		       ('att_2', 'msg_b', 'b.txt', 'text/plain', 3, 'attachment', 'r2_2', 2);
	`);
	const map = await loadAttachmentsByMessage(ctx, ["msg_a", "msg_b", ...ids(150), "msg_a"]);
	assert.equal(map.size, 2);
	assert.equal(map.get("msg_a").length, 1, "repeated id does not append its attachments twice");
	assert.equal(map.get("msg_b").length, 1);
});

test("serverFail descriptions never echo error internals", async () => {
	// The first query throws like a real D1 failure; afterwards the proxy
	// resolves so the trailing sessionState() call outside the per-method
	// try/catch does not escape processRequest.
	let thrown = false;
	const chain = new Proxy(function () {}, {
		apply: () => chain,
		get: (_, key) => {
			if (key === "then") return (onOk, onErr) => Promise.resolve([]).then(onOk, onErr);
			if (key === "catch") return (onErr) => Promise.resolve([]).catch(onErr);
			if (key === Symbol.toPrimitive) return () => "";
			return chain;
		},
	});
	const ctx = {
		env: {},
		db: new Proxy({}, {
			get(_, prop) {
				if (prop === "select" && !thrown) {
					thrown = true;
					throw new Error('Failed query: select "id" from "messages" params: ["p1","p2"]');
				}
				return chain;
			},
		}),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
	const response = await processRequest(ctx, {
		methodCalls: [["Email/get", { ids: ["msg_x"] }, "c0"]],
	});
	const [name, error] = response.methodResponses[0];
	assert.equal(name, "error");
	assert.equal(error.type, "serverFail");
	assert.ok(!/select|params|blob/i.test(error.description), `description leaks internals: ${error.description}`);
});
