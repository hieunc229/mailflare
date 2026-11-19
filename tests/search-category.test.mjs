import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-search-category-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { messages } from "./src/db/schema/index.ts";
			export { parseSearchQuery } from "./src/lib/search/query-utils.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
		`,
		resolveDir: root,
		sourcefile: "search-category-entry.ts",
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("category:promotions and category:primary parse, with the aliases promotion and inbox", () => {
	assert.equal(m.parseSearchQuery("category:promotions").category, "promotions");
	assert.equal(m.parseSearchQuery("category:Promotion").category, "promotions");
	assert.equal(m.parseSearchQuery("category:primary").category, "primary");
	assert.equal(m.parseSearchQuery("category:INBOX").category, "primary");
	const combined = m.parseSearchQuery("category:promotions from:x is:unread sale");
	assert.deepEqual([combined.category, combined.from, combined.read, combined.text], ["promotions", "x", "unread", "sale"]);
	assert.equal(combined.needsFullText, true);
	assert.equal(m.parseSearchQuery("category:promotions").needsFullText, false);
});

test("an unknown category value is left as free text", () => {
	const parsed = m.parseSearchQuery("category:social");
	assert.equal(parsed.category, undefined);
	assert.equal(parsed.text, "category:social");
});

test("category conditions select promotions or everything else", async (t) => {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, status, category, created_at) VALUES
			('promo', 'u', 'inbound', 'a@x.test', 'o@one.test', 'received', 'promotions', 1),
			('plain', 'u', 'inbound', 'b@x.test', 'o@one.test', 'received', NULL, 2);
	`);
	globalThis.__mailflareNodeEnv = { DB: database, MAILFLARE_RUNTIME: "node" };
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const db = m.getDb(globalThis.__mailflareNodeEnv);
	const ids = async (q) => (await db.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions(q))).map((row) => row.id).sort();
	assert.deepEqual(await ids("category:promotions"), ["promo"]);
	assert.deepEqual(await ids("category:primary"), ["plain"]);
	assert.deepEqual(await ids("category:promotions is:unread"), ["promo"]);
	assert.deepEqual(await ids("category:promotions from:b"), []);
});
