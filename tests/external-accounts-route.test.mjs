import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "external-accounts-route-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { decryptSecret } from "./src/lib/external-accounts/crypto.ts";
			export * as accounts from "./src/app/api/mailboxes/[id]/accounts/route.ts";
			export * as account from "./src/app/api/mailboxes/[id]/accounts/[accountId]/route.ts";
		`,
		resolveDir: root,
		sourcefile: "external-accounts-route-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, createSession, decryptSecret, accounts, account } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const listContext = (id) => ({ params: Promise.resolve({ id }) });
const itemContext = (id, accountId) => ({ params: Promise.resolve({ id, accountId }) });
const PASSWORD = "imap-secret-p@ss";
/** `openssl rand -base64 32` shape. */
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

async function fixture(t, { encryptionKey = KEY } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const addUser = sql.prepare(`INSERT INTO users
		(id, email, password_hash, name, role, is_primary_admin, can_manage_users, can_manage_mailboxes, created_by_user_id, created_at)
		VALUES (?, ?, 'hash', ?, 'user', 0, 0, 0, ?, 1)`);
	for (const row of [
		["owner", "owner@one.test", "Owner", null],
		["delegate", "delegate@one.test", "Delegate", "owner"],
		["reader", "reader@one.test", "Reader", "owner"],
		["stranger", "stranger@two.test", "Stranger", null],
	]) addUser.run(...row);
	sql.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'owner', 'one.test', 'zone-one', 'active', 1),
			('two', 'stranger', 'two.test', 'zone-two', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, use_all_domains, disabled, created_at) VALUES
			('m-personal', 'owner', 'one', 'owner', 'Owner', 'personal', 0, 0, 1),
			('m-shared', 'owner', 'one', 'support', 'Support', 'shared', 0, 0, 1),
			('m-disabled', 'owner', 'one', 'closed', 'Closed', 'personal', 0, 1, 1),
			('m-stranger', 'stranger', 'two', 'stranger', 'Stranger', 'personal', 0, 0, 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at)
			VALUES ('default', 'external-accounts-test', 'team', 'active', '[]', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at) VALUES
			('ma-full', 'm-shared', 'delegate', 'full_access', 'owner', 1),
			('ma-read', 'm-shared', 'reader', 'read_only', 'owner', 1);
	`);
	const env = { DB: database, BUCKET: {}, MAILFLARE_RUNTIME: "node", ...(encryptionKey ? { MAILFLARE_ENCRYPTION_KEY: encryptionKey } : {}) };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = new Map();
	for (const id of ["owner", "delegate", "reader", "stranger"]) sessions.set(id, await createSession(env, id));
	const request = (actor, path, method = "GET", body) => new Request(`https://mail.test${path}`, {
		method,
		headers: { Authorization: `Bearer ${sessions.get(actor)}`, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return {
		sql,
		db: getDb(env),
		encryptionKey,
		list: (actor, id) => accounts.GET(request(actor, `/api/mailboxes/${id}/accounts`), listContext(id)),
		create: (actor, id, body) => accounts.POST(request(actor, `/api/mailboxes/${id}/accounts`, "POST", body), listContext(id)),
		patch: (actor, id, accountId, body) => account.PATCH(request(actor, `/api/mailboxes/${id}/accounts/${accountId}`, "PATCH", body), itemContext(id, accountId)),
		remove: (actor, id, accountId) => account.DELETE(request(actor, `/api/mailboxes/${id}/accounts/${accountId}`, "DELETE"), itemContext(id, accountId)),
		rows: () => sql.prepare("SELECT * FROM external_accounts ORDER BY mailbox_id, host").all(),
		rowOf: (mailboxId) => sql.prepare("SELECT * FROM external_accounts WHERE mailbox_id = ?").get(mailboxId),
	};
}

const valid = (overrides = {}) => ({ protocol: "imap", host: "imap.example.com", port: 993, tlsMode: "implicit-tls", username: "me@example.com", password: PASSWORD, ...overrides });

test("the owner creates an account and reads it back without the password", async (t) => {
	const f = await fixture(t);
	const created = await f.create("owner", "m-personal", valid());
	assert.equal(created.status, 201);
	const { account: view } = await created.json();
	assert.equal(view.host, "imap.example.com");
	assert.equal(view.port, 993);
	assert.equal(view.tlsMode, "implicit-tls");
	assert.equal(view.passwordSet, true);
	assert.equal(view.enabled, true);
	assert.equal(view.lastSyncedAt, null);
	assert.equal(view.lastError, null);
	// The credential is never round-tripped, and neither is the poller's private state.
	assert.deepEqual(Object.keys(view).sort(), [
		"createdAt", "enabled", "host", "id", "lastError", "lastSyncedAt", "passwordSet", "port", "protocol", "tlsMode", "updatedAt", "username",
	]);

	const [row] = f.rows();
	assert.equal(row.mailbox_id, "m-personal");
	assert.equal(row.user_id, "owner");
	assert.ok(row.password_encrypted !== PASSWORD);
	assert.ok(!row.password_encrypted.includes(PASSWORD));
	assert.equal(await decryptSecret({ MAILFLARE_ENCRYPTION_KEY: f.encryptionKey }, row.password_encrypted), PASSWORD);

	const listed = await f.list("owner", "m-personal");
	assert.equal(listed.status, 200);
	const body = await listed.json();
	assert.equal(body.accounts.length, 1);
	assert.equal(body.accounts[0].id, row.id);
	const serialized = JSON.stringify(body);
	assert.ok(!serialized.includes(PASSWORD));
	assert.ok(!serialized.includes(row.password_encrypted));
	assert.equal("password" in body.accounts[0], false);
	assert.equal("passwordEncrypted" in body.accounts[0], false);
});

test("the same host and username cannot be fetched twice into one mailbox", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.create("owner", "m-personal", valid())).status, 201);
	const duplicate = await f.create("owner", "m-personal", valid({ password: "another-one" }));
	assert.equal(duplicate.status, 409);
	assert.equal(f.rows().length, 1);
	// Another mailbox on the same host is a different account, and so is another host in the same mailbox.
	assert.equal((await f.create("owner", "m-shared", valid())).status, 201);
	assert.equal((await f.create("owner", "m-personal", valid({ protocol: "pop3", host: "pop.example.com", port: 995 }))).status, 201);
	// Moving an account onto a host/username already used in its mailbox is refused the same way.
	const pop = f.sql.prepare("SELECT id FROM external_accounts WHERE mailbox_id = 'm-personal' AND protocol = 'pop3'").get();
	const collision = await f.patch("owner", "m-personal", pop.id, { host: "imap.example.com" });
	assert.equal(collision.status, 409);
});

test("access is the owner or a full_access delegate, nothing else", async (t) => {
	const f = await fixture(t);
	const created = await f.create("owner", "m-shared", valid());
	assert.equal(created.status, 201);
	const { account: view } = await created.json();

	// full_access delegate: reads, writes and deletes.
	const listed = await f.list("delegate", "m-shared");
	assert.equal(listed.status, 200);
	assert.equal((await listed.json()).accounts.length, 1);
	assert.equal((await f.patch("delegate", "m-shared", view.id, { enabled: false })).status, 200);

	// read_only delegate: the mailbox exists for them, but credentials are configuration.
	for (const response of [await f.list("reader", "m-shared"), await f.create("reader", "m-shared", valid({ username: "other" })), await f.patch("reader", "m-shared", view.id, { enabled: true }), await f.remove("reader", "m-shared", view.id)]) {
		assert.equal(response.status, 403);
	}

	// A stranger gets the same answer as for a mailbox that does not exist.
	for (const response of [await f.list("stranger", "m-shared"), await f.create("stranger", "m-shared", valid({ username: "other" })), await f.patch("stranger", "m-shared", view.id, { enabled: true }), await f.remove("stranger", "m-shared", view.id)]) {
		assert.equal(response.status, 404);
	}
	assert.equal((await f.list("stranger", "m-personal")).status, 404);
	assert.equal(f.rows().length, 1);
});

test("a disabled mailbox takes no new credentials", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.list("owner", "m-disabled")).status, 404);
	assert.equal((await f.create("owner", "m-disabled", valid())).status, 404);
	assert.equal(f.rows().length, 0);
});

test("validation rejects a bad port, host, protocol or tls mode before anything is encrypted", async (t) => {
	const f = await fixture(t);
	const cases = [
		valid({ port: 0 }),
		valid({ port: 65536 }),
		valid({ port: "993" }),
		valid({ host: "imap://example.com" }),
		valid({ host: "not a host" }),
		valid({ protocol: "smtp" }),
		valid({ tlsMode: "ssl" }),
		valid({ username: "  " }),
		valid({ password: "" }),
		{ ...valid(), password: undefined },
	];
	for (const body of cases) {
		const response = await f.create("owner", "m-personal", body);
		assert.equal(response.status, 400, JSON.stringify(body));
	}
	assert.equal(f.rows().length, 0);
	// A hostname is normalised, and tlsMode defaults instead of being required.
	const created = await f.create("owner", "m-personal", { ...valid({ host: "IMAP.Example.com." }), tlsMode: undefined });
	assert.equal(created.status, 201);
	const { account: normalised } = await created.json();
	assert.equal(normalised.host, "imap.example.com");
	assert.equal(normalised.tlsMode, "implicit-tls");
});

test("a patch re-encrypts only when it carries a new password", async (t) => {
	const f = await fixture(t);
	const { account: view } = await (await f.create("owner", "m-personal", valid())).json();
	const before = f.rows()[0].password_encrypted;

	const kept = await f.patch("owner", "m-personal", view.id, { enabled: false, port: 143, tlsMode: "starttls" });
	assert.equal(kept.status, 200);
	const afterKept = f.rows()[0];
	assert.equal(afterKept.password_encrypted, before);
	assert.equal(afterKept.enabled, 0);
	assert.equal(afterKept.port, 143);
	assert.equal(afterKept.tls_mode, "starttls");

	const rotated = await f.patch("owner", "m-personal", view.id, { password: "a-new-password" });
	assert.equal(rotated.status, 200);
	const afterRotated = f.rows()[0];
	assert.notEqual(afterRotated.password_encrypted, before);
	assert.equal(await decryptSecret({ MAILFLARE_ENCRYPTION_KEY: f.encryptionKey }, afterRotated.password_encrypted), "a-new-password");
	assert.ok(!("password" in (await rotated.json()).account));

	// An empty body is nothing to update; an unknown account is a 404.
	assert.equal((await f.patch("owner", "m-personal", view.id, {})).status, 400);
	assert.equal((await f.patch("owner", "m-personal", "ext_missing", { enabled: true })).status, 404);
	assert.equal((await f.patch("owner", "m-shared", view.id, { enabled: true })).status, 404);
});

test("a delete removes the credential instead of leaving it behind", async (t) => {
	const f = await fixture(t);
	const { account: view } = await (await f.create("owner", "m-personal", valid())).json();
	assert.equal((await f.remove("owner", "m-personal", view.id)).status, 200);
	assert.equal(f.rows().length, 0);
	assert.equal((await f.list("owner", "m-personal")).status, 200);
	assert.equal((await (await f.list("owner", "m-personal")).json()).accounts.length, 0);
	// Deleting through the wrong mailbox does not reach it, and a second delete is a 404.
	const other = await (await f.create("owner", "m-shared", valid())).json();
	assert.equal((await f.remove("owner", "m-personal", other.account.id)).status, 404);
	assert.equal(f.rows().length, 1);
	assert.equal((await f.remove("owner", "m-shared", other.account.id)).status, 200);
	assert.equal((await f.remove("owner", "m-shared", other.account.id)).status, 404);
});

test("a missing encryption key refuses the write and stores nothing", async (t) => {
	const f = await fixture(t, { encryptionKey: null });
	const response = await f.create("owner", "m-personal", valid());
	assert.equal(response.status, 503);
	const body = await response.json();
	assert.equal(body.code, "ENCRYPTION_KEY_MISSING");
	assert.match(body.error, /MAILFLARE_ENCRYPTION_KEY/);
	// The message names the setting, never the password.
	assert.ok(!JSON.stringify(body).includes(PASSWORD));
	assert.equal(f.rows().length, 0);
	// Reading the list still works: no key is needed to answer that.
	assert.equal((await f.list("owner", "m-personal")).status, 200);
});

test("an account deleted with its mailbox leaves no credential behind", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.create("owner", "m-personal", valid())).status, 201);
	f.sql.exec("DELETE FROM mailboxes WHERE id = 'm-personal'");
	assert.equal(f.rows().length, 0);
});

test("external_accounts is backed up, in the accounts group", () => {
	const exportSource = readFileSync(join(root, "src/lib/backups/export.ts"), "utf8");
	const groupSource = readFileSync(join(root, "src/lib/backups/table-groups.ts"), "utf8");
	const list = /export const BACKUP_TABLES: DatabaseBackupTable\[\] = \[([\s\S]*?)\];/.exec(exportSource)[1];
	const accounts = /id: "accounts"[^\n]*/.exec(groupSource)[0];
	// Included on purpose: the ciphertext is portable. Restoring it onto a different MAILFLARE_ENCRYPTION_KEY
	// leaves rows the poller cannot decrypt, which the operator fixes by re-entering the passwords.
	assert.ok(list.includes('"external_accounts"'), "BACKUP_TABLES lacks external_accounts");
	assert.ok(accounts.includes('"external_accounts"'), "the accounts group lacks external_accounts");
});
