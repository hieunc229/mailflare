import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-jmap-memo-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		processor: join(root, "src/lib/jmap/processor.ts"),
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

async function createContext(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	const env = { DB: database };
	const user = { id: "u1", email: "kevin@example.com", role: "admin" };
	return { env, db: getDb(env), auth: { userId: "u1", email: user.email, scopes: ["jmap"], mailboxIds: null, user }, accountId: "u1", origin: "http://test", createdIds: {} };
}

test("a write after cached reads still reports the state it moved to", async (t) => {
	const ctx = await createContext(t);
	const response = await processRequest(ctx, {
		using: [],
		methodCalls: [
			["Mailbox/get", {}, "a"],
			["Mailbox/set", { create: { f1: { name: "Projects", parentId: "mb1" } } }, "b"],
			["Mailbox/get", { ids: null }, "c"],
		],
	});
	const [[, first], [setName, set], [, last]] = response.methodResponses;
	assert.equal(setName, "Mailbox/set", JSON.stringify(set));
	assert.ok(set.created?.f1, JSON.stringify(set));
	assert.equal(set.oldState, first.state);
	assert.notEqual(set.newState, set.oldState);
	assert.equal(last.state, set.newState);
	assert.equal(response.sessionState, set.newState);
	assert.ok(last.list.some((mailbox) => mailbox.name === "Projects"), "the read after the write sees the new folder");
});
