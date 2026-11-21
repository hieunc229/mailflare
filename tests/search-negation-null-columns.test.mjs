import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-search-negation-"));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.MAILFLARE_DB_DIALECT = "postgres";
await build({
	stdin: {
		contents: `
			export { and } from "drizzle-orm";
			export { openExternalDatabase } from "./src/db/external.ts";
			export { resolveDatabaseConfig } from "./src/db/dialect.ts";
			export { applyPendingMigrations } from "./src/lib/migrations/service.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
			export { getDb, schema } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "search-negation-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { and, openExternalDatabase, resolveDatabaseConfig, applyPendingMigrations, buildSearchConditions, getDb, schema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const DB = openExternalDatabase(resolveDatabaseConfig({ DATABASE_URL: "pglite://memory" }), true);
await applyPendingMigrations(DB);
// The rows only need the searchable columns; skip the user and mailbox they would reference.
await DB.prepare("SET session_replication_role = replica").run();
const db = getDb({ DB });
const base = { userId: "u1", mailboxId: "mb1", direction: "inbound", fromAddr: "bob@y.test", toAddr: "a@x.test", subject: "Lunch", textBody: "see you", ccAddr: "c@y.test" };
await db.insert(schema.messages).values([
	{ ...base, id: "m_full" },
	{ ...base, id: "m_no_cc", ccAddr: null },
	{ ...base, id: "m_no_subject", subject: null },
	{ ...base, id: "m_no_body", textBody: null, htmlBody: null },
	{ ...base, id: "m_invoice", ccAddr: null, textBody: null, htmlBody: "<p>Your invoice</p>" },
]);

const search = async (query) => {
	const rows = await db.select({ id: schema.messages.id }).from(schema.messages).where(and(...buildSearchConditions(query)));
	return rows.map((row) => row.id).sort();
};

test("a negated term keeps messages whose optional columns are NULL", async () => {
	assert.deepEqual(await search("-invoice"), ["m_full", "m_no_body", "m_no_cc", "m_no_subject"]);
});

test("a positive term still matches through the HTML body", async () => {
	assert.deepEqual(await search("invoice"), ["m_invoice"]);
	assert.deepEqual(await search("lunch -invoice"), ["m_full", "m_no_body", "m_no_cc"]);
});
