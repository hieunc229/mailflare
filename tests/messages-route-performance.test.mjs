import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-messages-route-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.messagesRouteFixture;
});
const mocks = {
	"@/lib/cloudflare": "export function getEnv() { return globalThis.messagesRouteFixture.env; }",
	"@/lib/auth/cookies": "export async function getCurrentUser() { return globalThis.messagesRouteFixture.user; }",
	"@/lib/contacts/service": "export function getContactDisplayNameMap(env, userId, addresses) { return globalThis.messagesRouteFixture.contacts(userId, addresses); }",
	"@/lib/tracking/open-tracking": "export function getOpenCounts(env, ids) { return globalThis.messagesRouteFixture.opens(ids); }",
};
await build({
	entryPoints: {
		route: join(root, "src/app/api/messages/route.ts"),
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
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);
const request = (query = "") => new Request(`https://mail.example/api/messages?${query}`);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES
			('owner', 'owner@example.com', 'Owner', 'x', 'admin', 0),
			('other', 'other@example.com', 'Other', 'x', 'user', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'owner', 'example.com', 'zone', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
			('mine', 'owner', 'domain', 'owner', 'personal', 0, 0),
			('shared', 'other', 'domain', 'shared', 'shared', 0, 0),
			('private', 'other', 'domain', 'other', 'personal', 0, 0),
			('disabled', 'owner', 'domain', 'disabled', 'personal', 1, 0);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant', 'shared', 'owner', 'read_only', 0);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'test', 'team', 'active', 0);
	`);
	const state = {
		database,
		env: { DB: database },
		user: { id: "owner", email: "owner@example.com", name: "Owner", role: "admin" },
		queries: [],
		started: [],
		async read(label) { this.started.push(label); },
		async contacts(userId, addresses) {
			await this.read(`contacts:${userId}`);
			assert.ok(addresses.includes("friend@example.com"));
			return new Map([["friend@example.com", `Friend of ${userId}`]]);
		},
		async opens(ids) {
			await this.read("opens");
			return new Map(ids.map((id) => [id, 3]));
		},
		message(id, { mailbox = "mine", user = "owner", thread = "thread", status = "received", direction = "inbound", read = false, time = 1 } = {}) {
			database.db.prepare(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, thread_id, snippet, text_body, html_body, raw_r2_key, created_at)
				VALUES (?, ?, ?, ?, 'friend@example.com', 'friend@example.com', ?, ?, ?, 'preview', 'private body', '<p>private</p>', 'raw-key', ?)`).run(id, user, mailbox, direction, status, Number(read), thread, time);
		},
	};
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		state.queries.push(sql);
		function wrap(statement) {
			const bind = statement.bind.bind(statement);
			statement.bind = (...args) => wrap(bind(...args));
			const raw = statement.raw.bind(statement);
			statement.raw = async (...args) => {
				let label;
				if (sql.includes('from "messages"')) {
					label = sql.includes("group by") ? "threads" : sql.startsWith("select count(*)") ? "total" : "rows";
				} else if (sql.includes('from "outbound_jobs"')) label = "jobs";
				if (label) await state.read(label);
				return raw(...args);
			};
			return statement;
		}
		return wrap(prepare(sql));
	};
	globalThis.messagesRouteFixture = state;
	return state;
}

test("listed owned and read-only shared mailboxes reuse authorization without a second lookup", async (t) => {
	const f = await fixture(t);
	f.message("owned");
	f.message("delegated", { mailbox: "shared", user: "other" });
	for (const [mailbox, id] of [["mine", "owned"], ["shared", "delegated"]]) {
		f.queries.length = 0;
		const response = await GET(request(`mailboxId=${mailbox}`));
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).messages.map((row) => row.id), [id]);
		assert.equal(f.queries.filter((sql) => sql.includes('from "mailboxes"') && !sql.includes("join")).length, 0);
	}
});

test("missing, disabled, private, invalid grants and inactive sharing remain inaccessible", async (t) => {
	const f = await fixture(t);
	for (const mailbox of ["missing", "disabled", "private"]) {
		assert.equal((await GET(request(`mailboxId=${mailbox}`))).status, 404);
	}
	f.database.db.exec("UPDATE mailbox_access SET permission = 'invalid'");
	assert.equal((await GET(request("mailboxId=shared"))).status, 404);
	f.database.db.exec("UPDATE mailbox_access SET permission = 'read_only'; UPDATE license_settings SET state = 'inactive'");
	assert.equal((await GET(request("mailboxId=shared"))).status, 404);
	assert.equal(f.started.length, 0, "denied requests never load mail or enrichment");
	f.user = null;
	f.queries.length = 0;
	assert.equal((await GET(request())).status, 401);
	assert.equal(f.queries.length, 0);
});

test("explicit orphaned mailbox keeps the existing access fallback", async (t) => {
	const f = await fixture(t);
	f.database.db.pragma("foreign_keys = OFF");
	f.database.db.exec("UPDATE mailboxes SET domain_id = 'missing' WHERE id = 'mine'");
	f.database.db.pragma("foreign_keys = ON");
	f.message("orphan");
	assert.equal((await GET(request("mailboxId=mine"))).status, 200);
});

// Hold reads at their asynchronous boundary, then inspect which siblings started.
// No elapsed-time performance threshold: the assertion measures overlap, not speed.
async function holdReads(f, labels, callback) {
	const gate = Promise.withResolvers();
	const entered = Promise.withResolvers();
	f.read = async (label) => {
		f.started.push(label);
		if (labels.includes(label)) {
			entered.resolve();
			await gate.promise;
		}
	};
	const pending = GET(request("mailboxId=mine&scheduled=true"));
	try {
		await entered.promise;
		await setImmediate();
		callback();
	} finally {
		gate.resolve();
		await pending;
	}
	return (await pending).json();
}

function schedule(f) {
	f.message("scheduled", { direction: "outbound", status: "queued" });
	f.database.db.exec("INSERT INTO outbound_jobs (id, user_id, message_id, payload, scheduled_at, created_at, updated_at) VALUES ('job', 'owner', 'scheduled', '{}', 2000000000, 0, 0)");
}

test("ungrouped total and page reads start together", async (t) => {
	const f = await fixture(t);
	schedule(f);
	const body = await holdReads(f, ["total"], () => assert.ok(f.started.includes("rows"), "page read must start before count resolves"));
	assert.equal(body.total, 1);
	assert.equal(body.messages.length, 1);
});

test("thread, schedule, tracking and contact enrichment reads overlap", async (t) => {
	const f = await fixture(t);
	schedule(f);
	const body = await holdReads(f, ["threads", "jobs", "opens", "contacts:owner"], () => {
		for (const label of ["threads", "jobs", "opens", "contacts:owner"]) assert.ok(f.started.includes(label), `${label} must start before other enrichment resolves`);
	});
	const [message] = body.messages;
	assert.equal(message.scheduledAt, "2033-05-18T03:33:20.000Z");
	assert.equal(message.openCount, 3);
	assert.equal(message.fromContactName, "Owner");
	assert.equal(message.toContactName, "Friend of owner");
	assert.equal(message.snippet, "preview");
	for (const key of ["textBody", "htmlBody", "rawR2Key"]) assert.equal(key in message, false);
});

test("grouped unread counts and actions stay folder-scoped while thread totals exclude draft and trash", async (t) => {
	const f = await fixture(t);
	f.message("old", { time: 1 });
	f.message("head", { time: 2, read: true });
	f.message("archive", { status: "archived", time: 3 });
	f.message("draft", { status: "draft", time: 4 });
	f.message("trash", { status: "trash", time: 5 });
	f.message("private", { mailbox: "private", user: "other", time: 6 });
	const response = await GET(request("mailboxId=mine&status=received&group=thread"));
	const body = await response.json();
	assert.equal(body.grouped, true);
	assert.equal(body.total, 1);
	assert.equal(body.messages[0].id, "head");
	assert.equal(body.messages[0].threadCount, 3);
	assert.equal(body.messages[0].threadUnread, 1);
	assert.deepEqual(body.messages[0].threadMessageIds.sort(), ["head", "old"]);
	const ungrouped = await (await GET(request("mailboxId=mine&status=received&limit=1&offset=1"))).json();
	assert.equal(ungrouped.total, 2);
	assert.equal(ungrouped.messages[0].id, "old");
	assert.equal(ungrouped.messages[0].threadUnread, 2);
	const drafts = await (await GET(request("mailboxId=mine&status=draft&group=thread"))).json();
	assert.equal(drafts.grouped, false);
	assert.equal(drafts.messages[0].id, "draft");
});

test("all-mailbox lists keep per-owner contacts and reflect revoked sharing on the next request", async (t) => {
	const f = await fixture(t);
	f.message("own");
	f.message("shared", { mailbox: "shared", user: "other", time: 2 });
	f.message("private", { mailbox: "private", user: "other", time: 3 });
	const body = await (await GET(request())).json();
	assert.deepEqual(body.messages.map((row) => [row.id, row.fromContactName]), [["shared", "Friend of other"], ["own", "Friend of owner"]]);
	f.database.db.exec("DELETE FROM mailbox_access");
	assert.deepEqual((await (await GET(request())).json()).messages.map((row) => row.id), ["own"]);
	assert.equal((await GET(request("mailboxId=shared"))).status, 404);
});

test("empty pages preserve total and skip unnecessary thread and scheduled reads", async (t) => {
	const f = await fixture(t);
	schedule(f);
	const body = await (await GET(request("mailboxId=mine&scheduled=true&offset=100"))).json();
	assert.equal(body.total, 1);
	assert.deepEqual(body.messages, []);
	assert.ok(!f.started.includes("threads"));
	assert.ok(!f.started.includes("jobs"));
	assert.ok(!f.started.some((label) => label.startsWith("contacts:")));
});
