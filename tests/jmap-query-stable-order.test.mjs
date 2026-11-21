import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-stable-order-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// PostgreSQL returns rows with equal sort keys in no fixed order, which SQLite
// happens to hide, so this runs Email/query on PGlite. The schema picks its
// dialect when first imported.
process.env.MAILFLARE_DB_DIALECT = "postgres";

await build({
	stdin: {
		contents: `
			export { getDatabaseConfig } from "./src/db/with-database.ts";
			export { openExternalDatabase } from "./src/db/external.ts";
			export { applyPendingMigrations } from "./src/lib/migrations/service.ts";
			export { getDb } from "./src/db/index.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-stable-order-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { getDatabaseConfig, openExternalDatabase, applyPendingMigrations, getDb, processRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const MAILBOX = "mbx_test";
const COUNT = 300;

test("Email/query pages through equal sort values without repeats or gaps", async () => {
	const database = openExternalDatabase(getDatabaseConfig({ DATABASE_URL: "pglite://memory" }), true);
	assert.equal((await applyPendingMigrations(database)).ready, true);
	const env = { DB: database };
	await database.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', true, 1)`).run();
	await database.prepare(`INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1)`).run();
	await database.prepare(`INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES ('${MAILBOX}', 'admin', 'one', 'support', 'Support', true, 'personal', false, 1)`).run();
	// Three distinct timestamps, so most rows tie with many others.
	const values = Array.from({ length: COUNT }, (_, i) => `('m_${String((i * 7919) % COUNT).padStart(4, "0")}', 'admin', '${MAILBOX}', 'inbound', 'a@one.test', 'support@one.test', 'received', false, false, ${i % 3})`);
	await database.prepare(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, starred, created_at) VALUES ${values.join(", ")}`).run();

	const ctx = {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
	const seen = [];
	for (let position = 0; position < COUNT; position += 7) {
		const res = await processRequest(ctx, { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/query", { accountId: "admin", position, limit: 7 }, "q"]] });
		seen.push(...res.methodResponses[0][1].ids);
	}
	assert.equal(seen.length, COUNT);
	assert.equal(new Set(seen).size, COUNT);
});
