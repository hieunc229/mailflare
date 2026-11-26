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
			export { externalAccounts } from "./src/db/schema/index.ts";
			export { getTableConfig } from "drizzle-orm/sqlite-core";
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
const { SqliteDatabase, applyMigrations, createSession, encryptSecret, decryptSecret, exportDatabaseRecords, restoreDatabaseRecords, BackupRestoreError, restoreRoute, externalAccounts, getTableConfig } =
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

/** A target database that already holds one credential, so a failed restore can prove it survived. */
async function targetWithExistingRow(t) {
	const target = await seededDatabase(t);
	target.existingSealed = await encryptSecret({ MAILFLARE_ENCRYPTION_KEY: KEY }, "live-password");
	target.sql
		.prepare(`INSERT INTO external_accounts (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, created_at, updated_at)
			VALUES ('ext_live', 'm-personal', 'admin', 'imap', 'live.example.com', 993, 'implicit-tls', 'live@example.com', ?, 1, 1, 1)`)
		.run(target.existingSealed);
	return target;
}

/** Nothing was torn down: the same single row, the same ciphertext, and the users table still populated. */
function assertUntouched(target) {
	const rows = target.sql.prepare("SELECT id, password_encrypted FROM external_accounts").all();
	assert.deepEqual(rows.map((row) => row.id), ["ext_live"]);
	// Byte for byte: a refused restore must not have touched the credential either.
	assert.equal(rows[0].password_encrypted, target.existingSealed);
	assert.equal(target.sql.prepare("SELECT count(*) AS n FROM users").get().n, 1);
	assert.equal(target.sql.prepare("SELECT count(*) AS n FROM mailboxes").get().n, 1);
}

/** Every row a restore would touch, so "untouched" can be compared exactly. */
async function snapshotOf(fixture) {
	const ids = (table) => fixture.sql.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);
	return {
		users: ids("users"),
		domains: ids("domains"),
		mailboxes: ids("mailboxes"),
		accounts: fixture.sql.prepare("SELECT id, password_encrypted FROM external_accounts ORDER BY id").all(),
		appSettings: fixture.sql.prepare("SELECT app_name FROM app_settings WHERE id = 'default'").all(),
	};
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
	const target = await targetWithExistingRow(t);

	const plaintext = structuredClone(document);
	plaintext.tables.external_accounts[0].password_encrypted = "my-plaintext-password";
	const refused = await target.restore(plaintext);
	assert.equal(refused.status, 400);
	const body = await refused.json();
	assert.match(body.error, /external account record/i);
	assert.match(body.error, /password_encrypted/);
	// The message names the column, never the offending value.
	assert.ok(!JSON.stringify(body).includes("my-plaintext-password"));
	// Refused before the teardown: the row that was already there is still there, unchanged.
	assertUntouched(target);

	for (const value of ["", "not base64!", Buffer.alloc(20).toString("base64"), `${"A".repeat(6000)}`]) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].password_encrypted = value;
		assert.equal((await target.restore(broken)).status, 400, value.slice(0, 12));
	}
});

test("a restore refuses a cursor that is not the protocol's bounded JSON shape", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await targetWithExistingRow(t);
	const cases = [
		// Not JSON at all, or JSON that is not an object.
		["not JSON", undefined],
		['{"uidValidity":', undefined],
		["42", undefined],
		["[1,2,3]", undefined],
		// Unknown keys: the shape is the format, so a poller cannot smuggle state through it.
		[JSON.stringify({ big: "x".repeat(70 * 1024) }), undefined],
		[JSON.stringify({ uidValidity: 1, lastUid: 2, extra: true }), undefined],
		// Wrong types for the IMAP keys.
		[JSON.stringify({ uidValidity: "1", lastUid: 2 }), undefined],
		[JSON.stringify({ uidValidity: 1.5, lastUid: 2 }), undefined],
		[JSON.stringify({ uidValidity: 1, lastUid: 2 ** 33 }), undefined],
		// A POP3 cursor on an IMAP account, and an IMAP cursor on a POP3 account.
		[JSON.stringify({ uidls: ["a", "b"] }), undefined],
		[JSON.stringify({ uidValidity: 1, lastUid: 2 }), "pop3"],
		// Over the byte bound in UTF-8 even though JS would count fewer code units.
		[JSON.stringify({ uidls: ["\u00e9".repeat(40 * 1024)] }), "pop3"],
	];
	for (const [cursor, protocol] of cases) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].sync_cursor = cursor;
		if (protocol) {
			broken.tables.external_accounts[0].protocol = protocol;
			broken.tables.external_accounts[0].port = 995;
		}
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, `${String(cursor).slice(0, 20)} / ${protocol ?? "imap"}`);
		assert.match((await refused.json()).error, /sync_cursor/);
	}
	assertUntouched(target);

	// Null and the documented shapes are accepted, per protocol.
	const accepted = [
		[null, undefined],
		[JSON.stringify({ uidValidity: 1, lastUid: 2 }), undefined],
		[JSON.stringify({}), undefined],
		[JSON.stringify({ uidls: ["a", "b"] }), "pop3"],
		[JSON.stringify({ uidls: [], lastCheckedAt: new Date().toISOString() }), "pop3"],
	];
	for (const [cursor, protocol] of accepted) {
		const ok = structuredClone(document);
		ok.tables.external_accounts[0].sync_cursor = cursor;
		if (protocol) {
			ok.tables.external_accounts[0].protocol = protocol;
			ok.tables.external_accounts[0].port = 995;
		}
		const response = await target.restore(ok);
		assert.equal(response.status, 200, `${String(cursor).slice(0, 20)} / ${protocol ?? "imap"}`);
	}
});

test("an explicit null for a NOT NULL column is refused before the teardown, not after it", async (t) => {
	// The required columns come from the table definition, so a column added later is covered without editing
	// this test: null is bound as NULL, which the INSERT would reject only after the old rows are gone.
	const { document } = await documentWithAccount(t);
	const target = await targetWithExistingRow(t);
	const required = getTableConfig(externalAccounts).columns.filter((column) => column.notNull).map((column) => column.name);
	assert.ok(required.includes("tls_mode") && required.includes("enabled") && required.includes("password_encrypted"), required.join(","));
	for (const column of required) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0][column] = null;
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, column);
		const body = await refused.json();
		assert.match(body.error, new RegExp(column), column);
		assert.equal(body.error.includes("null"), false, "the message must not echo the value");
		assertUntouched(target);
	}
	// A non-string TLS mode is refused rather than coerced, and so is a made-up one.
	for (const tlsMode of [1, true, "ssl", "IMPLICIT-TLS", " implicit-tls"]) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].tls_mode = tlsMode;
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, String(tlsMode));
		assert.match((await refused.json()).error, /tls_mode/);
		assertUntouched(target);
	}
	for (const enabled of [null, 2, -1, "yes", "1"]) {
		const broken = structuredClone(document);
		broken.tables.external_accounts[0].enabled = enabled;
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, String(enabled));
		assert.match((await refused.json()).error, /enabled/);
		assertUntouched(target);
	}
	// Omitting them is not the same as null: the column defaults apply and the restore succeeds.
	const omitted = structuredClone(document);
	delete omitted.tables.external_accounts[0].tls_mode;
	delete omitted.tables.external_accounts[0].enabled;
	assert.equal((await target.restore(omitted)).status, 200);
	const restored = target.sql.prepare("SELECT tls_mode, enabled FROM external_accounts WHERE id = 'ext_1'").get();
	assert.deepEqual(restored, { tls_mode: "implicit-tls", enabled: 1 });
});

test("the other ways an imported row could fail the insert are refused before the teardown", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await targetWithExistingRow(t);
	const refuse = async (mutate, column) => {
		const broken = structuredClone(document);
		mutate(broken.tables.external_accounts);
		const refused = await target.restore(broken);
		assert.equal(refused.status, 400, column);
		assert.match((await refused.json()).error, new RegExp(column));
		assertUntouched(target);
	};

	// A column the table does not have: the INSERT would fail with an unknown column, after the teardown.
	await refuse((rows) => { rows[0].made_up_column = "x"; }, "made_up_column");
	// A duplicate primary key in the document (distinct tuples, so the identity check alone missed it).
	await refuse((rows) => rows.push({ ...rows[0], username: "other@example.com" }), "\\(row 2, id\\)");
	// Text PostgreSQL cannot store (NUL) and text MySQL would silently rewrite (a lone surrogate).
	await refuse((rows) => { rows[0].username = "user\u0000name"; }, "host|username");
	await refuse((rows) => { rows[0].host = "imap\u0001.example.com"; }, "host");
	await refuse((rows) => { rows[0].username = "user\uD800name"; }, "username");
	await refuse((rows) => { rows[0].host = "imap\uD800.example.com"; }, "host");
	// A URL-shaped host: the API would store only the host name, so this is not a value this app wrote.
	for (const host of ["imap.example.com:993", "imaps://imap.example.com", "imap.example.com/path", "IMAP.example.com", "imap.example.com.", "localhost"]) {
		await refuse((rows) => { rows[0].host = host; }, "host");
	}
	// Epoch seconds JavaScript cannot turn into a Date: the settings API would throw on the first read.
	for (const column of ["created_at", "updated_at"]) {
		await refuse((rows) => { rows[0][column] = 8.64e12 + 1; }, column);
		await refuse((rows) => { rows[0][column] = 2 ** 53 - 1; }, column);
	}
	await refuse((rows) => { rows[0].last_synced_at = 8.64e12 + 1; }, "last_synced_at");
	// The last representable second and a plausible date are both accepted.
	const boundary = structuredClone(document);
	boundary.tables.external_accounts[0].created_at = 8.64e12;
	boundary.tables.external_accounts[0].updated_at = 1;
	boundary.tables.external_accounts[0].last_synced_at = 1_700_000_000;
	assert.equal((await target.restore(boundary)).status, 200);
	assert.equal(target.sql.prepare("SELECT created_at FROM external_accounts WHERE id = 'ext_1'").get().created_at, 8.64e12);

	// SQLite (and PostgreSQL, and D1) compare text byte for byte, so a trailing space and a differently cased
	// mailbox id are different accounts and must restore. MySQL is the dialect that equates them, and its own
	// probe covers that side. These go last because they replace the rows the refusals above left alone.
	const distinct = structuredClone(document);
	distinct.tables.external_accounts.push({ ...distinct.tables.external_accounts[0], id: "ext_2", username: `${distinct.tables.external_accounts[0].username}  ` });
	const twinMailbox = { ...distinct.tables.mailboxes[0], id: distinct.tables.mailboxes[0].id.toUpperCase(), local_part: "admin-twin" };
	distinct.tables.mailboxes.push(twinMailbox);
	distinct.tables.external_accounts.push({ ...distinct.tables.external_accounts[0], id: "ext_3", mailbox_id: twinMailbox.id });
	assert.equal((await target.restore(distinct)).status, 200);
	assert.deepEqual(target.sql.prepare("SELECT id FROM external_accounts ORDER BY id").all().map((row) => row.id), ["ext_1", "ext_2", "ext_3"]);
});

test("a restore refuses a document whose rows would collide or point at a missing mailbox", async (t) => {
	const { document } = await documentWithAccount(t);
	const target = await targetWithExistingRow(t);
	// The unique tuple is enforced by the index after the teardown, so it is checked before it.
	const duplicate = structuredClone(document);
	duplicate.tables.external_accounts.push({ ...document.tables.external_accounts[0], id: "ext_2" });
	const refused = await target.restore(duplicate);
	assert.equal(refused.status, 400);
	assert.match((await refused.json()).error, /external account record \(row 2, username\)/);
	assertUntouched(target);

	// The mailbox foreign key is enforced the same way, and `mailboxes` is restored from this document.
	const orphan = structuredClone(document);
	orphan.tables.external_accounts[0].mailbox_id = "m-not-in-this-backup";
	const orphaned = await target.restore(orphan);
	assert.equal(orphaned.status, 400);
	assert.match((await orphaned.json()).error, /\(row 1, mailbox_id\)/);
	assertUntouched(target);
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

test("a driver failure mid-restore rolls back: the live rows and the error both survive intact", async (t) => {
	const { document, sealed } = await documentWithAccount(t);
	const target = await targetWithExistingRow(t);
	// A rejection the preflight cannot foresee, injected at the last table restored. This is the case that used
	// to delete the live credential and only then fail.
	target.sql.exec(`CREATE TRIGGER f36_reject_restore BEFORE INSERT ON external_accounts WHEN NEW.username = 'rejected-by-db'
		BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END`);
	const broken = structuredClone(document);
	broken.tables.external_accounts[0].username = "rejected-by-db";
	const response = await target.restore(broken);
	assert.equal(response.status, 400);
	const text = JSON.stringify(await response.json());
	// The route hides the driver error, whose message carries the INSERT and the bound ciphertext.
	assert.match(text, /could not be restored/i);
	assert.ok(!text.includes(sealed));
	assert.ok(!text.includes(PASSWORD));
	assert.ok(!/Failed query/i.test(text));
	// The transaction put back everything the teardown removed: the old row, its ciphertext, and the parents.
	assertUntouched(target);
	assert.equal(target.sql.prepare("SELECT count(*) AS n FROM domains").get().n, 1);
	assert.equal(target.sql.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 1);
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

test("a database without transactions (a D1 binding) still restores, on the preflight alone", async (t) => {
	// D1 has no interactive transaction, so `runInTransaction` runs the writes directly: the shape checks above
	// are the whole guard there. This wrapper is a `D1Database` without `transaction`, like a Worker binding.
	const inner = await seededDatabase(t);
	const plain = {
		prepare: (...args) => inner.database.prepare(...args),
		batch: (...args) => inner.database.batch(...args),
		exec: (...args) => inner.database.exec(...args),
	};
	const source = await documentWithAccount(t);
	const document = source.document;
	assert.equal(await restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(document)).buffer).then(() => "ok"), "ok");
	const restored = inner.sql.prepare("SELECT id, password_encrypted FROM external_accounts").all();
	assert.deepEqual(restored, [{ id: "ext_1", password_encrypted: source.sealed }]);
	// A malformed document is refused before anything is written, exactly as on a transactional driver.
	const broken = structuredClone(document);
	broken.tables.external_accounts[0].id = "ext_2";
	broken.tables.external_accounts.push({ ...broken.tables.external_accounts[0] });
	await assert.rejects(restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(broken)).buffer), /\(row 2, id\)/);
	assert.deepEqual(inner.sql.prepare("SELECT id FROM external_accounts").all(), [{ id: "ext_1" }]);
});

test("an insert the plan cannot build is refused before any write, not half way through", async (t) => {
	// An empty object in `contacts` passes the generic row check and then has no column to insert: the gate saw it
	// reach the write phase, where on a database without a transaction the old rows were already gone.
	const inner = await seededDatabase(t);
	const plain = {
		prepare: (...args) => inner.database.prepare(...args),
		batch: (...args) => inner.database.batch(...args),
		exec: (...args) => inner.database.exec(...args),
	};
	const { document } = await documentWithAccount(t);
	const before = await snapshotOf(inner);
	const broken = structuredClone(document);
	broken.tables.contacts.push({});
	await assert.rejects(restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(broken)).buffer), (error) => {
		assert.ok(error instanceof BackupRestoreError);
		assert.match(error.message, /invalid contacts record/);
		// Refused before the teardown, so there is nothing to warn about.
		assert.ok(!/cannot roll it back/i.test(error.message));
		return true;
	});
	assert.deepEqual(await snapshotOf(inner), before);
});

test("on a database without a transaction, an authored error after the writes began still warns", async (t) => {
	// The classification rule: once the teardown has started, ANY failure means the installation may be partially
	// replaced — including a BackupRestoreError, which is otherwise the shape of a preflight refusal.
	const inner = await seededDatabase(t);
	const { document } = await documentWithAccount(t);
	let batches = 0;
	const plain = {
		prepare: (...args) => inner.database.prepare(...args),
		exec: (...args) => inner.database.exec(...args),
		async batch(statements) {
			batches += 1;
			// Let the teardown and the parent inserts happen, then refuse the credentials with authored text.
			if (statements.some((statement) => /external_accounts/.test(statement.sql))) {
				throw new BackupRestoreError("Backup contains an invalid external account record (row 1, host)");
			}
			return inner.database.batch(statements);
		},
	};
	await assert.rejects(restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(document)).buffer), (error) => {
		assert.ok(error instanceof BackupRestoreError);
		assert.match(error.message, /invalid external account record/i);
		assert.match(error.message, /cannot roll it back/i);
		assert.match(error.message, /may already have been replaced/i);
		return true;
	});
	assert.ok(batches > 0);
});

test("a database that cannot roll back says so when a restore fails", async (t) => {
	// D1 (and any HTTP driver) has no interactive transaction. The restore still runs there, but a failure that
	// the preflight did not foresee has already replaced data, and the admin has to be told that plainly.
	const inner = await seededDatabase(t);
	const plain = {
		prepare: (...args) => inner.database.prepare(...args),
		batch: (...args) => inner.database.batch(...args),
		exec: (...args) => inner.database.exec(...args),
		// No `transaction`, like a Worker binding.
	};
	inner.sql.exec(`CREATE TRIGGER f36_no_rollback BEFORE INSERT ON external_accounts
		BEGIN SELECT RAISE(ABORT, 'injected'); END`);
	const { document } = await documentWithAccount(t);
	await assert.rejects(restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(document)).buffer), (error) => {
		assert.ok(error instanceof BackupRestoreError);
		assert.match(error.message, /cannot roll it back/i);
		assert.match(error.message, /may already have been replaced/i);
		assert.match(error.message, /again|snapshot/i);
		// The driver's own message (statement and parameters) never reaches the admin.
		assert.ok(!/injected/.test(error.message));
		return true;
	});
	// A refusal before any write is reported as itself: nothing was applied, so there is nothing to warn about.
	inner.sql.exec("DROP TRIGGER f36_no_rollback");
	const broken = structuredClone(document);
	broken.tables.external_accounts[0].password_encrypted = "plaintext";
	await assert.rejects(restoreDatabaseRecords(plain, new TextEncoder().encode(JSON.stringify(broken)).buffer), (error) => {
		assert.ok(error instanceof BackupRestoreError);
		assert.match(error.message, /password_encrypted/);
		assert.ok(!/cannot roll it back/i.test(error.message));
		return true;
	});
});

test("an unrelated caller cannot join the restore's transaction, and its acknowledged write survives the rollback", async (t) => {
	// The round-4 gate scenario: pause the restore mid-transaction, let another request read and write through the
	// same adapter, then let the restore fail. Before the fix that caller saw the uncommitted replacement rows,
	// was acknowledged, and its write was rolled back with the restore.
	const inner = await seededDatabase(t);
	const source = await documentWithAccount(t);
	const bad = structuredClone(source.document);
	// A rejection the preflight cannot foresee, in the last table restored.
	inner.sql.exec(`CREATE TRIGGER f36_isolation BEFORE INSERT ON external_accounts
		BEGIN SELECT RAISE(ABORT, 'injected'); END`);

	let releaseRestore;
	const paused = new Promise((resolve) => { releaseRestore = resolve; });
	let reachedRestore;
	const reached = new Promise((resolve) => { reachedRestore = resolve; });
	const scope = (tx) => ({
		prepare: (sql) => tx.prepare(sql),
		batch: async (statements) => {
			// Pause once, just before the credential rows are written: everything before it has been deleted and
			// replaced inside the open transaction.
			if (statements.some((statement) => /external_accounts/.test(statement.sql))) {
				reachedRestore();
				await paused;
			}
			return tx.batch(statements);
		},
		exec: (sql) => tx.exec(sql),
		transaction: (work) => tx.transaction(work),
	});
	// A `D1Database` that owns its transactions: the callback gets a connection-bound view, the adapter does not.
	const adapter = {
		prepare: (...args) => inner.database.prepare(...args),
		batch: (...args) => inner.database.batch(...args),
		exec: (...args) => inner.database.exec(...args),
		supportsTransaction: () => true,
		transaction: (work) => inner.database.transaction((tx) => work(scope(tx))),
	};

	const order = [];
	const restore = restoreDatabaseRecords(adapter, new TextEncoder().encode(JSON.stringify(bad)).buffer).then(
		() => order.push("restore-ok"),
		() => order.push("restore-failed"),
	);
	await reached;
	// An ordinary caller on the same adapter, while the restore holds the connection.
	const read = adapter.prepare("SELECT display_name FROM mailboxes WHERE id = 'm-personal'").all().then((result) => {
		order.push("read");
		return result;
	});
	const write = adapter.prepare("UPDATE app_settings SET app_name = ? WHERE id = 'default'").bind("concurrent-write").run().then(() => {
		order.push("write");
	});
	// It waits instead of reading the uncommitted replacement.
	const firstOfRace = await Promise.race([read.then(() => "read"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]);
	assert.equal(firstOfRace, "blocked");
	releaseRestore();
	await restore;
	const rows = await read;
	await write;
	// The restore rolled back everything it wrote — and the unrelated write, acknowledged only after that, stands.
	assert.equal(order.at(-1), "write");
	assert.deepEqual(order.slice(0, 2), ["restore-failed", "read"]);
	assert.equal(rows.results[0].display_name, "Admin");
	assert.equal(inner.sql.prepare("SELECT app_name FROM app_settings WHERE id = 'default'").get().app_name, "concurrent-write");
	assert.equal(inner.sql.prepare("SELECT count(*) AS n FROM external_accounts").get().n, 0);
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
