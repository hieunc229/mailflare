import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "external-accounts-restore-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { encryptSecret, decryptSecret } from "./src/lib/external-accounts/crypto.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords, BackupRestoreError } from "./src/lib/backups/export.ts";
			export * as restoreRoute from "./src/app/api/backups/restore/route.ts";
		`,
		resolveDir: root,
		sourcefile: "external-accounts-restore-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, createSession, encryptSecret, decryptSecret, exportDatabaseRecords, restoreDatabaseRecords, BackupRestoreError, restoreRoute } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const PASSWORD = "imap-secret-p@ss";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const OTHER_KEY = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

async function seededDatabase(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	sql.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'admin@one.test', 'hash', 'Admin', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, use_all_domains, disabled, created_at)
			VALUES ('m-personal', 'admin', 'one', 'admin', 'Admin', 'personal', 0, 0, 1);
	`);
	const env = { DB: database, BUCKET: {}, MAILFLARE_RUNTIME: "node", MAILFLARE_ENCRYPTION_KEY: KEY };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	/**
	 * A restore replaces the sessions table, so the token from before it is gone afterwards. Each call signs in
	 * again the way a browser would, which is also why the second restore in a row is not authorized by the first
	 * token.
	 */
	const restore = async (document) => {
		const session = await createSession(env, "admin");
		const form = new FormData();
		form.set("backup", new File([JSON.stringify(document)], "backup.json", { type: "application/json" }));
		return restoreRoute.POST(new Request("https://mail.test/api/backups/restore", { method: "POST", headers: { Authorization: `Bearer ${session}` }, body: form }));
	};
	return { database, sql, env, restore };
}

/** A document holding one external account, exported from a real database. */
async function documentWithAccount(t) {
	const source = await seededDatabase(t);
	const sealed = await encryptSecret({ MAILFLARE_ENCRYPTION_KEY: KEY }, PASSWORD);
	source.sql
		.prepare(`INSERT INTO external_accounts (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, created_at, updated_at)
			VALUES ('ext_1', 'm-personal', 'admin', 'imap', 'imap.example.com', 993, 'implicit-tls', 'me@example.com', ?, 1, 1, 1)`)
		.run(sealed);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(source.database)));
	return { document, sealed };
}

test("a valid backup restores under the same key and under a different key without touching the envelope", async (t) => {
	const { document, sealed } = await documentWithAccount(t);
	assert.equal(document.tables.external_accounts[0].password_encrypted, sealed);

	const same = await seededDatabase(t);
	assert.equal((await same.restore(document)).status, 200);
	assert.equal(same.sql.prepare("SELECT password_encrypted FROM external_accounts").get().password_encrypted, sealed);
	assert.equal(await decryptSecret({ MAILFLARE_ENCRYPTION_KEY: KEY }, sealed), PASSWORD);

	// A wrong-key restore is a supported operation: the row comes back byte for byte, only unreadable until the
	// operator re-enters the password. Nothing here decrypts or re-encrypts.
	const other = await seededDatabase(t);
	assert.equal((await other.restore(document)).status, 200);
	assert.equal(other.sql.prepare("SELECT password_encrypted FROM external_accounts").get().password_encrypted, sealed);
	await assert.rejects(decryptSecret({ MAILFLARE_ENCRYPTION_KEY: OTHER_KEY }, sealed), /could not be read/);
});

test("a restore refuses a plaintext credential before it tears anything down", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await seededDatabase(t);
	target.sql
		.prepare(`INSERT INTO external_accounts (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, created_at, updated_at)
			VALUES ('ext_live', 'm-personal', 'admin', 'imap', 'live.example.com', 993, 'implicit-tls', 'live@example.com', ?, 1, 1, 1)`)
		.run("a2VwdC1saXZlLWVudmVsb3BlLXZhbHVlLXBsYWNlaG9sZGVy");

	const plaintext = structuredClone(document);
	plaintext.tables.external_accounts[0].password_encrypted = "my-plaintext-password";
	const refused = await target.restore(plaintext);
	assert.equal(refused.status, 400);
	const body = await refused.json();
	assert.match(body.error, /external account record/i);
	assert.match(body.error, /password_encrypted/);
	// The message names the column, never the offending value.
	assert.ok(!JSON.stringify(body).includes("my-plaintext-password"));
	// Refused before the teardown: the row that was already there is still there.
	assert.equal(target.sql.prepare("SELECT id FROM external_accounts").all().map((row) => row.id).join(","), "ext_live");

	for (const value of ["", "not base64!", Buffer.alloc(20).toString("base64"), `${"A".repeat(6000)}`]) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].password_encrypted = value;
		assert.equal((await target.restore(broken)).status, 400, value.slice(0, 12));
	}
});

test("a restore refuses a cursor that is not bounded JSON", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await seededDatabase(t);
	for (const cursor of ["not JSON", '{"uidValidity":', "42", JSON.stringify({ big: "x".repeat(70 * 1024) })]) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].sync_cursor = cursor;
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, cursor.slice(0, 12));
		assert.match((await refused.json()).error, /sync_cursor/);
	}
	// Null and ordinary JSON are both accepted.
	for (const cursor of [null, JSON.stringify({ uidValidity: 1, lastUid: 2 }), JSON.stringify({ uidls: ["a", "b"] })]) {
		const ok = structuredClone(document);
		ok.tables.external_accounts[0].sync_cursor = cursor;
		const response = await target.restore(ok);
		assert.equal(response.status, 200, String(cursor));
	}
});

test("a restore refuses an out-of-range port or unknown protocol before the teardown", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await seededDatabase(t);
	const cases = [
		["port", 70000],
		["port", "993"],
		["protocol", "smtp"],
		["tls_mode", "ssl"],
		["host", "h".repeat(192)],
		["enabled", "yes"],
	];
	for (const [column, value] of cases) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0][column] = value;
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, `${column}=${value}`);
		assert.match((await refused.json()).error, new RegExp(column));
	}
});

test("a driver failure during restore is reported without the statement or its parameters", async (t) => {
	const { document, sealed } = await documentWithAccount(t);
	// Two rows with one primary key reach the insert phase, so the failure is a real driver error carrying the
	// bound ciphertext — the exact shape that must not be echoed to the client.
	const broken = structuredClone(document);
	broken.tables.external_accounts.push({ ...document.tables.external_accounts[0] });
	const target = await seededDatabase(t);
	const response = await target.restore(broken);
	assert.equal(response.status, 400);
	const text = JSON.stringify(await response.json());
	assert.match(text, /could not be restored/i);
	assert.ok(!text.includes(sealed));
	assert.ok(!text.includes(PASSWORD));
	assert.ok(!/"Failed query"/.test(text));
});

test("restore validation throws the typed error the route is allowed to repeat", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await seededDatabase(t);
	const broken = structuredClone(document);
	broken.tables.external_accounts[0].password_encrypted = "plain";
	await assert.rejects(restoreDatabaseRecords(target.database, new TextEncoder().encode(JSON.stringify(broken)).buffer), (error) => {
		assert.ok(error instanceof BackupRestoreError);
		assert.equal(error.name, "BackupRestoreError");
		return true;
	});
});

test("a mailbox transfer does not let a stale owner's deletion remove the account", async (t) => {
	const fixture = await seededDatabase(t);
	fixture.sql
		.prepare(`INSERT INTO external_accounts (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, created_at, updated_at)
			VALUES ('ext_1', 'm-personal', 'admin', 'imap', 'imap.example.com', 993, 'implicit-tls', 'me@example.com', ?, 1, 1, 1)`)
		.run(await encryptSecret({ MAILFLARE_ENCRYPTION_KEY: KEY }, PASSWORD));
	fixture.sql.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('new-owner', 'new@one.test', 'hash', 'New', 'user', 0, 1);
		UPDATE domains SET user_id = 'new-owner' WHERE id = 'one';
		UPDATE mailboxes SET user_id = 'new-owner' WHERE id = 'm-personal';
	`);
	// The account follows its mailbox, not the userId hint it was created with: deleting the old owner
	// (which cascades their mailboxes) must not take a mailbox that now belongs to someone else with it.
	fixture.sql.exec("DELETE FROM users WHERE id = 'admin'");
	assert.equal(fixture.sql.prepare("SELECT count(*) AS n FROM mailboxes WHERE id = 'm-personal'").get().n, 1);
	assert.equal(fixture.sql.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 1);
	assert.equal(fixture.sql.prepare("SELECT user_id FROM external_accounts").get().user_id, "admin");
});
