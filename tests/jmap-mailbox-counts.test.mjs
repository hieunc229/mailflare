import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-jmap-counts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		processor: join(root, "src/lib/jmap/processor.ts"),
		mailboxes: join(root, "src/lib/jmap/mailboxes.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		dbIndex: join(root, "src/db/index.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "cloudflare:workers", "postal-mime", "mimetext"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { processRequest } = await load("processor");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const { getDb } = await load("dbIndex");
const { needsCounts } = await load("mailboxes");

async function createContext(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	const sql = [];
	const prepare = database.db.prepare.bind(database.db);
	database.db.prepare = (text) => { sql.push(text); return prepare(text); };
	const env = { DB: database };
	const user = { id: "u1", email: "kevin@example.com", role: "admin" };
	return { env, db: getDb(env), auth: { userId: "u1", email: user.email, scopes: ["jmap"], mailboxIds: null, user }, accountId: "u1", origin: "http://test", createdIds: {}, sql };
}

const countQueries = (ctx) => ctx.sql.filter((s) => /group by/i.test(s) && /messages/i.test(s)).length;
const call = async (ctx, name, args) => (await processRequest(ctx, { using: [], methodCalls: [[name, args, "a"]] })).methodResponses[0][1];

test("Mailbox/get with no properties runs one count query and returns totalEmails", async (t) => {
	const ctx = await createContext(t);
	const { list } = await call(ctx, "Mailbox/get", {});
	assert.equal(countQueries(ctx), 1);
	assert.equal(typeof list[0].totalEmails, "number");
});

test("Mailbox/get with only name and role runs no count query", async (t) => {
	const ctx = await createContext(t);
	const { list } = await call(ctx, "Mailbox/get", { properties: ["name", "role"] });
	assert.equal(countQueries(ctx), 0);
	assert.deepEqual(Object.keys(list[0]).sort(), ["id", "name", "role"]);
});

test("Mailbox/get asking for one count property runs the count query", async (t) => {
	const ctx = await createContext(t);
	const { list } = await call(ctx, "Mailbox/get", { properties: ["unreadEmails"] });
	assert.equal(countQueries(ctx), 1);
	assert.ok("unreadEmails" in list[0]);
});

test("Mailbox/query runs no count query and keeps its result", async (t) => {
	const ctx = await createContext(t);
	const { ids, total } = await call(ctx, "Mailbox/query", {});
	assert.equal(countQueries(ctx), 0);
	assert.equal(ids.length, total);
	assert.ok(total >= 7);
});

test("needsCounts is true unless only non-count properties are asked for", () => {
	assert.equal(needsCounts(null), true);
	assert.equal(needsCounts(undefined), true);
	assert.equal(needsCounts(["name"]), false);
	assert.equal(needsCounts(["name", "totalThreads"]), true);
});
