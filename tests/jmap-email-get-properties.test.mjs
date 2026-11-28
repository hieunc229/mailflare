import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-jmap-get-props-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		processor: join(root, "src/lib/jmap/processor.ts"),
		emails: join(root, "src/lib/jmap/emails.ts"),
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
const { emailGetNeedsBodies } = await load("emails");

async function createContext(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@x.test', 'kevin@example.com', 'Hi', 'see you', 'received', 1)").run();
	const sql = [];
	const prepare = database.db.prepare.bind(database.db);
	database.db.prepare = (text) => { sql.push(text); return prepare(text); };
	const env = { DB: database };
	const user = { id: "u1", email: "kevin@example.com", role: "admin" };
	return { env, db: getDb(env), auth: { userId: "u1", email: user.email, scopes: ["jmap"], mailboxIds: null, user }, accountId: "u1", origin: "http://test", createdIds: {}, sql };
}

const get = async (ctx, properties) => (await processRequest(ctx, { using: [], methodCalls: [["Email/get", { ids: ["m1"], properties }, "a"]] })).methodResponses[0][1];
const readsBodies = (ctx) => ctx.sql.some((text) => /text_body/.test(text) && /^select/i.test(text));

test("emailGetNeedsBodies is false for metadata properties", () => {
	for (const properties of [["id", "subject", "from", "keywords", "mailboxIds", "receivedAt", "threadId", "hasAttachment", "attachments", "header:subject:asText"], []]) {
		assert.equal(emailGetNeedsBodies(properties), false, JSON.stringify(properties));
	}
});

test("emailGetNeedsBodies is true for body-derived properties", () => {
	for (const property of ["size", "preview", "bodyStructure", "bodyValues", "textBody", "htmlBody"]) assert.equal(emailGetNeedsBodies([property]), true, property);
	assert.equal(emailGetNeedsBodies(null), true);
	assert.equal(emailGetNeedsBodies(undefined), true);
});

test("metadata-only Email/get reads no body columns", async (t) => {
	const ctx = await createContext(t);
	const { list } = await get(ctx, ["id", "subject"]);
	assert.deepEqual(list[0], { id: "m1", subject: "Hi" });
	assert.equal(readsBodies(ctx), false, ctx.sql.join("\n"));
});

test("size still comes from the bodies", async (t) => {
	const ctx = await createContext(t);
	const { list } = await get(ctx, ["size", "preview"]);
	assert.equal(list[0].size, 7);
	assert.equal(readsBodies(ctx), true);
});

test("no properties returns the full object", async (t) => {
	const ctx = await createContext(t);
	const { list } = await get(ctx, null);
	assert.equal(list[0].textBody.length, 1);
	assert.equal(list[0].size, 7);
});
