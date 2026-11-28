import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-search-negation-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/search/query-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildFtsMatch, parseSearchQuery } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("a query with no text terms has nothing to match", () => {
	assert.deepEqual(buildFtsMatch(parseSearchQuery("is:unread", "UTC")), { match: null, exclude: null });
});

const { app, newDatabase } = await loadApp("search-negation-sqlite", `
	export { and } from "drizzle-orm";
	export { buildSearchConditions } from "./src/lib/search/conditions.ts";
	export { messages } from "./src/db/schema/index.ts";
`);

test("on SQLite a negation-only search keeps every other message, and positive terms narrow it", async (t) => {
	const { db } = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
			('m-news', 'admin', 'mb-team', 'inbound', 'a@example.net', 'team@example.com', 'newsletter weekly', 'received', 1),
			('m-invoice', 'admin', 'mb-team', 'inbound', 'a@example.net', 'team@example.com', 'invoice due', 'received', 2),
			('m-hello', 'admin', 'mb-team', 'inbound', 'a@example.net', 'team@example.com', 'hello there', 'received', 3),
			('m-news-hello', 'admin', 'mb-team', 'inbound', 'a@example.net', 'team@example.com', 'newsletter hello', 'received', 4);`);
	const search = async (query) => (await db.select({ id: app.messages.id }).from(app.messages).where(app.and(...app.buildSearchConditions(query)))).map((row) => row.id).sort();
	assert.deepEqual(await search("-newsletter"), ["m-hello", "m-invoice"]);
	assert.deepEqual(await search("-newsletter hello"), ["m-hello"]);
});
