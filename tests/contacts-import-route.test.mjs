import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-contact-import-route-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export * as importRoute from "./src/app/api/import/contacts/route.ts";
		`,
		resolveDir: root,
		sourcefile: "contact-import-route-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createSession, importRoute } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const addUser = sql.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', ?, 'admin', 1)");
	for (const row of [["owner", "owner@one.test", "Owner"], ["manager", "manager@one.test", "Manager"]]) addUser.run(...row);
	sql.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'owner', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, use_all_domains, disabled, created_at) VALUES
			('m-owner', 'owner', 'one', 'owner', 'Owner', 'personal', 0, 0, 1),
			('m-shared', 'owner', 'one', 'support', 'Support', 'shared', 0, 0, 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('a1', 'm-shared', 'manager', 'full_access', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at) VALUES ('default', 'contacts-import-test', 'team', 'active', '[]', 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node", CF_TOKEN: "test-only" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = new Map();
	for (const id of ["owner", "manager"]) sessions.set(id, await createSession(env, id));
	const post = (actor, mailboxId) => importRoute.POST(new Request("https://mail.test/api/import/contacts", {
		method: "POST",
		headers: { Authorization: `Bearer ${sessions.get(actor)}`, "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, format: "vcard", items: [{ vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nEMAIL:jane@x.test\nTEL:+1 555 0100\nEND:VCARD", hasPhoto: false }] }),
	}));
	return { post, sql };
}

test("the address book owner can import, into a personal or a shared mailbox's book", async (t) => {
	const { post, sql } = await fixture(t);
	for (const mailbox of ["m-owner", "m-shared"]) assert.equal((await post("owner", mailbox)).status, 200, mailbox);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts WHERE user_id='owner'").get().n, 1);
});

test("a full-access delegate of a shared mailbox cannot import into the owner's address book", async (t) => {
	const { post, sql } = await fixture(t);
	assert.equal((await post("manager", "m-shared")).status, 404);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contacts").get().n, 0);
	assert.equal(sql.prepare("SELECT count(*) AS n FROM contact_details").get().n, 0);
});
