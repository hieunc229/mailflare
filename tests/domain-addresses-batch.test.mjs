import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-domain-addresses-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { getMailboxDomainAddresses, getMailboxesDomainAddresses } from "./src/lib/mailboxes/domain-addresses.ts";
		`,
		resolveDir: root,
		sourcefile: "domain-addresses-batch-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, getMailboxDomainAddresses, getMailboxesDomainAddresses } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('u1', 'u1@d1.test', 'h', 'U1', 'admin', 1, 1),
			('u2', 'u2@e1.test', 'h', 'U2', 'admin', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('d1', 'u1', 'd1.test', 'z1', 'active', 1),
			('d2', 'u1', 'd2.test', 'z2', 'active', 1),
			('d3', 'u1', 'd3.test', 'z3', 'pending', 1),
			('e1', 'u2', 'e1.test', 'z4', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, use_all_domains, created_at) VALUES
			('m1', 'u1', 'd1', 'sam', 1, 1),
			('m2', 'u1', 'd2', 'sam', 1, 1),
			('m3', 'u1', 'd1', 'pat', 1, 1),
			('m4', 'u1', 'd1', 'kim', 0, 1),
			('m5', 'u2', 'e1', 'lee', 1, 1),
			('m6', 'u1', 'd1', 'zed', 1, 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, created_at) VALUES
			('a1', 'm4', 'd2', 'kim2', 1, 1),
			('a2', 'm4', 'd1', 'kim3', 0, 1),
			('a3', 'm6', 'd2', 'zed', 0, 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	const inputs = database.db.prepare("SELECT * FROM mailboxes ORDER BY id").all()
		.map((row) => ({ id: row.id, domainId: row.domain_id, localPart: row.local_part, useAllDomains: !!row.use_all_domains }));
	return { database, db: getDb(env), inputs };
}

// Hand-derived from the single-mailbox rules before the batch existed.
const expected = {
	false: {
		m1: ["sam@d1.test"],
		m2: ["sam@d2.test"],
		m3: ["pat@d1.test", "pat@d2.test"],
		m4: ["kim@d1.test", "kim2@d2.test"],
		m5: ["lee@e1.test"],
		m6: ["zed@d1.test"],
	},
	true: {
		m1: ["sam@d1.test"],
		m2: ["sam@d2.test"],
		m3: ["pat@d1.test", "pat@d2.test"],
		m4: ["kim@d1.test", "kim2@d2.test", "kim3@d1.test"],
		m5: ["lee@e1.test"],
		m6: ["zed@d1.test", "zed@d2.test"],
	},
};

test("batch equals the single calls for every fixture mailbox, with and without disabled aliases", async (t) => {
	const { db, inputs } = await fixture(t);
	for (const includeDisabled of [false, true]) {
		const batch = await getMailboxesDomainAddresses(db, inputs, includeDisabled);
		for (const mailbox of inputs) {
			assert.deepEqual(batch.get(mailbox.id), expected[includeDisabled][mailbox.id], `${mailbox.id} batch ${includeDisabled}`);
			assert.deepEqual(await getMailboxDomainAddresses(db, mailbox, includeDisabled), expected[includeDisabled][mailbox.id], `${mailbox.id} single ${includeDisabled}`);
		}
	}
});

test("a missing primary domain maps to an empty array", async (t) => {
	const { db } = await fixture(t);
	const batch = await getMailboxesDomainAddresses(db, [{ id: "ghost", domainId: "nope", localPart: "x", useAllDomains: true }]);
	assert.deepEqual(batch.get("ghost"), []);
});

test("empty input returns an empty map without querying", async (t) => {
	const { database, db } = await fixture(t);
	let statements = 0;
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => { statements++; return prepare(sql); };
	const batch = await getMailboxesDomainAddresses(db, []);
	assert.equal(batch.size, 0);
	assert.equal(statements, 0);
});

test("query count does not grow with mailbox count", async (t) => {
	const { database, db, inputs } = await fixture(t);
	let statements = 0;
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => { statements++; return prepare(sql); };
	await getMailboxesDomainAddresses(db, inputs.slice(0, 1));
	const one = statements;
	statements = 0;
	await getMailboxesDomainAddresses(db, inputs);
	assert.equal(statements, one);
	assert.ok(statements <= 6, `${statements} statements`);
});

test("more than 90 domains are chunked", async (t) => {
	const { database, db } = await fixture(t);
	const insert = database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES (?, 'u1', ?, ?, 'active', 1)");
	for (let index = 0; index < 120; index++) insert.run(`x${index}`, `x${index}.test`, `zx${index}`);
	database.db.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, use_all_domains, created_at) VALUES ('big', 'u1', 'd1', 'big', 1, 1)");
	const batch = await getMailboxesDomainAddresses(db, [{ id: "big", domainId: "d1", localPart: "big", useAllDomains: true }]);
	assert.equal(batch.get("big").length, 122);
});
