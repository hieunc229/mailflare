import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// D1 rejects a statement with more than 100 bound parameters. The message list is the
// biggest offender: a page of up to 100 rows is looked up by id, thread key, address and so on.
const D1_MAX_BOUND_PARAMETERS = 100;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-messages-d1-params-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.messagesParamsFixture;
});
const mocks = {
	"@/lib/cloudflare": "export function getEnv() { return globalThis.messagesParamsFixture.env; }",
	"@/lib/auth/cookies": "export async function getCurrentUser() { return globalThis.messagesParamsFixture.user; }",
};
await build({
	entryPoints: {
		route: join(root, "src/app/api/messages/route.ts"),
		inBatches: join(root, "src/lib/db-params.ts"),
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
	plugins: [{
		name: "message-route-fixtures",
		setup(builder) {
			builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server.js", external: true }));
			builder.onResolve({ filter: /^@\/lib\// }, (args) => args.path in mocks ? { path: args.path, namespace: "mock" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});
const { GET } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);
const { selectInBatches, D1_MAX_BOUND_PARAMETERS: LIMIT } = await import(pathToFileURL(join(outDir, "inBatches.mjs")).href);
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('owner', 'owner@example.com', 'Owner', 'x', 'admin', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'owner', 'example.com', 'zone', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES ('mine', 'owner', 'domain', 'owner', 'personal', 0, 0);
	`);
	const state = { env: { DB: database }, user: { id: "owner", email: "owner@example.com", name: "Owner", role: "admin" }, maxBound: 0 };
	// Behave like D1: refuse a statement that binds too many parameters.
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		function wrap(statement) {
			const bind = statement.bind.bind(statement);
			statement.bind = (...args) => {
				state.maxBound = Math.max(state.maxBound, args.length);
				if (args.length > D1_MAX_BOUND_PARAMETERS) throw new Error(`D1_ERROR: too many SQL variables (${args.length} bound): ${sql.slice(0, 160)}`);
				return wrap(bind(...args));
			};
			return statement;
		}
		return wrap(prepare(sql));
	};
	globalThis.messagesParamsFixture = state;
	return { database, state };
}

function insertThreads(database, threads, { direction = "inbound", status = "received", perThread = 2 } = {}) {
	const insert = database.db.prepare(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, thread_id, snippet, text_body, html_body, raw_r2_key, created_at)
		VALUES (?, 'owner', 'mine', ?, ?, ?, ?, 0, ?, 'preview', 'b', '<p>b</p>', 'raw', ?)`);
	for (let thread = 0; thread < threads; thread += 1) {
		for (let index = 0; index < perThread; index += 1) {
			insert.run(`m-${thread}-${index}`, direction, `from${thread}@example.com`, `to${thread}@example.com`, status, `thread-${thread}`, 1000 + thread * 10 + index);
		}
	}
}

test("a conversation list of 100 rows stays under D1's bound-parameter limit and keeps every thread count", async (t) => {
	const { database } = await fixture(t);
	insertThreads(database, 100);
	const response = await GET(new Request("https://mail.example/api/messages?group=thread&limit=100"));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.messages.length, 100);
	for (const message of body.messages) {
		assert.equal(message.threadCount, 2, `${message.threadId} count`);
		assert.equal(message.threadUnread, 2, `${message.threadId} unread`);
		assert.equal(message.threadMessageIds.length, 2);
	}
});

test("a flat list of 100 rows stays under the limit too", async (t) => {
	const { database } = await fixture(t);
	insertThreads(database, 100);
	const response = await GET(new Request("https://mail.example/api/messages?limit=100"));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.messages.length, 100);
	assert.ok(body.messages.every((message) => message.threadCount === 2));
});

test("the scheduled view looks up 100 rows' jobs within the limit", async (t) => {
	const { database } = await fixture(t);
	insertThreads(database, 100, { direction: "outbound", status: "queued", perThread: 1 });
	const job = database.db.prepare("INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, scheduled_at, created_at, updated_at) VALUES (?, 'owner', ?, 'queued', '{}', 5000, 0, 0)");
	for (let thread = 0; thread < 100; thread += 1) job.run(`job-${thread}`, `m-${thread}-0`);
	const response = await GET(new Request("https://mail.example/api/messages?scheduled=true&limit=100"));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.messages.length, 100);
	assert.ok(body.messages.every((message) => message.scheduledAt));
});

test("selectInBatches fills each statement to exactly the limit, counted with Drizzle's own parameters", async (t) => {
	const { database } = await fixture(t);
	const { drizzle } = await import("drizzle-orm/d1");
	const { and, count, eq, inArray, notInArray } = await import("drizzle-orm");
	const { messages } = await import(pathToFileURL(join(outDir, "schema.mjs")).href);
	assert.equal(LIMIT, D1_MAX_BOUND_PARAMETERS);
	const db = drizzle(database);
	const seen = [];
	// The thread-count query: 1 mailbox + the thread ids + 2 statuses.
	const ids = Array.from({ length: 250 }, (_, index) => `thread-${index}`);
	const rows = await selectInBatches(ids, (batch) => {
		const query = db
			.select({ threadId: messages.threadId, total: count() })
			.from(messages)
			.where(and(eq(messages.mailboxId, "mine"), inArray(messages.threadId, batch), notInArray(messages.status, ["draft", "trash"])))
			.groupBy(messages.threadId);
		seen.push({ ids: batch.length, params: query.toSQL().params.length });
		return query;
	});
	assert.deepEqual(rows, []);
	// 1 probe statement, then 97 ids per batch (97 + 3 fixed = 100), then the remainder.
	assert.deepEqual(seen.slice(1).map((entry) => entry.ids), [97, 97, 56]);
	assert.ok(seen.every((entry) => entry.params <= D1_MAX_BOUND_PARAMETERS), JSON.stringify(seen));
	assert.equal(Math.max(...seen.map((entry) => entry.params)), D1_MAX_BOUND_PARAMETERS);
});
