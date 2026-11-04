import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailbox-settings-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { getMailboxAccessLevel, listAccessibleMailboxIds } from "./src/lib/mailboxes/access.ts";
			export { getAuthorizedSenderAddress } from "./src/lib/email/sender.ts";
			export * as detail from "./src/app/api/mailboxes/[id]/route.ts";
			export * as aliases from "./src/app/api/mailboxes/[id]/aliases/route.ts";
			export * as avatar from "./src/app/api/mailboxes/[id]/avatar/route.ts";
			export * as accountMailboxes from "./src/app/api/accounts/[id]/mailboxes/route.ts";
		`,
		resolveDir: root,
		sourcefile: "mailbox-settings-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, createSession, getMailboxAccessLevel, listAccessibleMailboxIds,
	getAuthorizedSenderAddress, detail, aliases, avatar, accountMailboxes } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const context = id => ({ params: Promise.resolve({ id }) });

async function fixture(t, plan = "team") {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const addUser = sql.prepare(`INSERT INTO users
		(id, email, password_hash, name, role, is_primary_admin, can_manage_users, can_manage_mailboxes, created_by_user_id, deleted_at, created_at)
		VALUES (?, ?, 'hash', ?, ?, ?, ?, ?, ?, ?, 1)`);
	for (const row of [
		["primary", "owner@one.test", "Owner", "admin", 1, 0, 0, null, null],
		["manager", "manager@one.test", "Manager", "admin", 0, 1, 0, "primary", null],
		["mailbox-admin", "limited@one.test", "Limited", "admin", 0, 0, 1, "primary", null],
		["other-admin", "other@two.test", "Other admin", "admin", 0, 0, 0, "primary", null],
		["sam", "sam@one.test", "Sam", "user", 0, 0, 1, "manager", null],
		["remote", "remote@two.test", "Remote", "user", 0, 0, 0, "other-admin", null],
		["deleted", "deleted@one.test", "Deleted", "user", 0, 0, 0, "primary", 1],
	]) addUser.run(...row);
	sql.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'primary', 'one.test', 'zone-one', 'active', 1),
			('two', 'other-admin', 'two.test', 'zone-two', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, use_all_domains, disabled, created_at) VALUES
			('m-owner', 'primary', 'one', 'owner', 'Owner', 'personal', 0, 0, 1),
			('m-sam', 'sam', 'one', 'sam', 'Stale name', 'personal', 0, 0, 1),
			('m-sales', 'sam', 'one', 'sales', 'Sales', 'personal', 0, 0, 1),
			('m-other', 'other-admin', 'two', 'other', 'Other admin', 'personal', 0, 0, 1),
			('m-remote', 'remote', 'two', 'remote', 'Remote', 'personal', 0, 0, 1),
			('m-deleted', 'deleted', 'one', 'deleted', 'Deleted', 'personal', 0, 0, 1),
			('m-disabled', 'sam', 'one', 'disabled', 'Disabled', 'personal', 0, 1, 1),
			('m-shared', 'primary', 'one', 'support', 'Support', 'shared', 0, 0, 1),
			('m-other-shared', 'other-admin', 'two', 'team', 'Team', 'shared', 0, 0, 1);
		UPDATE users SET avatar_key='avatars/sam' WHERE id='sam';
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at)
			VALUES ('default', 'settings-test', 'team', 'active', '[]', 1);
	`);
	sql.prepare("UPDATE license_settings SET plan=?, state=? WHERE id='default'").run(plan, plan === "community" ? "inactive" : "active");
	const objects = new Map([["avatars/sam", new Uint8Array([1, 2, 3])]]);
	const env = {
		DB: database, MAILFLARE_RUNTIME: "node", CF_TOKEN: "test-only",
		BUCKET: {
			async put(key, data) { objects.set(key, new Uint8Array(data)); },
			async get(key) {
				const bytes = objects.get(key);
				return bytes ? { body: bytes, httpMetadata: { contentType: "image/webp" }, httpEtag: '"test"' } : null;
			},
		},
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const sessions = new Map();
	for (const id of ["primary", "manager", "mailbox-admin", "other-admin", "sam", "remote"]) {
		sessions.set(id, await createSession(env, id));
	}
	const calls = [];
	const rules = [];
	t.mock.method(globalThis, "fetch", async (url, init = {}) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, "https://api.cloudflare.com", "tests must not contact real services");
		assert.match(parsed.pathname, /\/email\/routing\/rules/);
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ method, body });
		if (method === "GET") return Response.json({ success: true, result: rules });
		if (method === "DELETE") return Response.json({ success: true, result: {} });
		const rule = { ...body, id: `rule-${rules.length}` };
		rules.push(rule);
		return Response.json({ success: true, result: rule });
	});
	const request = (actor, path, method = "GET", body) => new Request(`https://mail.test${path}`, {
		method, headers: { Authorization: `Bearer ${sessions.get(actor)}`, Origin: "https://mail.test", ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
		...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
	});
	const read = (actor, id) => detail.GET(request(actor, `/api/mailboxes/${id}`), context(id));
	const patch = (actor, id, body) => detail.PATCH(request(actor, `/api/mailboxes/${id}`, "PATCH", body), context(id));
	return { sql, env, db: getDb(env), objects, calls, request, read, patch };
}

test("primary admin can open indirectly created accounts and edit their primary mailbox identity", async t => {
	const f = await fixture(t);
	const listed = await accountMailboxes.GET(f.request("primary", "/api/accounts/sam/mailboxes"), context("sam"));
	assert.equal(listed.status, 200);
	assert.deepEqual((await listed.json()).mailboxes.map(row => row.id).sort(), ["m-disabled", "m-sales", "m-sam"]);
	const response = await f.read("primary", "m-sam");
	assert.equal(response.status, 200);
	const { mailbox } = await response.json();
	assert.equal(mailbox.displayName, "Sam");
	assert.equal(mailbox.hasAvatar, true);
	assert.equal(mailbox.isPrimary, true);
	assert.equal(mailbox.permission, null);
	assert.equal("ownerEmail" in mailbox, false);
	const saved = await f.patch("primary", "m-sam", { displayName: "Sam Updated", signature: "Thanks", useAllDomains: true });
	assert.equal(saved.status, 200);
	assert.equal((await saved.json()).mailbox.displayName, "Sam Updated");
	assert.deepEqual({ ...f.sql.prepare("SELECT name, avatar_key FROM users WHERE id='sam'").get() }, { name: "Sam Updated", avatar_key: "avatars/sam" });
	assert.equal(f.sql.prepare("SELECT signature FROM mailboxes WHERE id='m-sam'").get().signature, "Thanks");
	assert.equal(f.sql.prepare("SELECT display_name FROM mailboxes WHERE id='m-sales'").get().display_name, "Sales");
	assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='primary'").get().name, "Owner");
	assert.ok(f.calls.some(call => call.method === "POST"));
});

test("secondary mailbox name and avatar remain independent of the account", async t => {
	const f = await fixture(t);
	const response = await f.patch("primary", "m-sales", { displayName: "Billing" });
	assert.equal(response.status, 200);
	const { mailbox } = await response.json();
	assert.equal(mailbox.isPrimary, false);
	assert.equal(mailbox.displayName, "Billing");
	assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='sam'").get().name, "Sam");
	assert.equal((await f.patch("primary", "m-sam", { displayName: " " })).status, 400);
});

test("user managers can configure ordinary accounts but cannot manage administrators", async t => {
	const f = await fixture(t);
	for (const id of ["m-sam", "m-remote"]) {
		assert.equal((await f.read("manager", id)).status, 200);
		assert.equal((await f.patch("manager", id, { displayName: "Managed" })).status, 200);
	}
	assert.equal((await accountMailboxes.GET(f.request("manager", "/api/accounts/remote/mailboxes"), context("remote"))).status, 200);
	for (const id of ["m-owner", "m-other", "m-shared"]) {
		assert.equal((await f.read("manager", id)).status, 404);
		assert.equal((await f.patch("manager", id, { displayName: "Denied" })).status, 404);
	}
	assert.equal((await f.patch("primary", "m-other", { displayName: "Other Updated" })).status, 200);
});

test("mailbox-only admins and ordinary users cannot configure other users' mailboxes", async t => {
	const f = await fixture(t);
	for (const actor of ["mailbox-admin", "other-admin", "remote"]) {
		assert.equal((await f.read(actor, "m-sam")).status, 404);
		assert.equal((await f.patch(actor, "m-sam", { displayName: "Denied" })).status, 404);
		assert.equal((await aliases.GET(f.request(actor, "/api/mailboxes/m-sam/aliases"), context("m-sam"))).status, 404);
		assert.equal((await aliases.POST(f.request(actor, "/api/mailboxes/m-sam/aliases", "POST", { localPart: "denied", domainId: "one" }), context("m-sam"))).status, 404);
		assert.equal((await aliases.DELETE(f.request(actor, "/api/mailboxes/m-sam/aliases?aliasId=missing", "DELETE"), context("m-sam"))).status, 404);
		assert.equal((await avatar.GET(f.request(actor, "/api/mailboxes/m-sam/avatar"), context("m-sam"))).status, 404);
		assert.equal((await avatar.POST(f.request(actor, "/api/mailboxes/m-sam/avatar", "POST", new FormData()), context("m-sam"))).status, 404);
	}
	for (const id of ["missing", "m-disabled", "m-deleted"]) {
		assert.equal((await f.read("primary", id)).status, 404);
		assert.equal((await f.patch("primary", id, { displayName: "Denied" })).status, 404);
	}
});

test("owners and shared mailbox grants keep their existing settings permissions", async t => {
	const f = await fixture(t);
	assert.equal((await f.patch("sam", "m-sales", { displayName: "My Sales" })).status, 200);
	f.sql.exec("INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES ('grant','m-shared','sam','read_only','primary',1)");
	assert.equal((await f.read("sam", "m-shared")).status, 200);
	assert.equal((await f.patch("sam", "m-shared", { displayName: "Denied" })).status, 404);
	f.sql.exec("UPDATE mailbox_access SET permission='full_access' WHERE id='grant'");
	assert.equal((await f.patch("sam", "m-shared", { displayName: "Shared Updated" })).status, 200);
});

test("administrative mailbox settings preserve the account license requirement", async t => {
	for (const plan of ["community", "pro"]) {
		const f = await fixture(t, plan);
		assert.equal((await f.read("primary", "m-sam")).status, plan === "pro" ? 200 : 404);
		assert.equal((await f.patch("primary", "m-sam", { displayName: "Licensed" })).status, plan === "pro" ? 200 : 404);
		assert.equal((await f.patch("sam", "m-sales", { displayName: "My Sales" })).status, 200);
	}
});

test("administrators can manage aliases within the mailbox's domain-owner scope", async t => {
	const f = await fixture(t);
	const path = "/api/mailboxes/m-sam/aliases";
	const read = await aliases.GET(f.request("primary", path), context("m-sam"));
	assert.equal(read.status, 200);
	assert.deepEqual((await read.json()).availableDomains.map(row => row.id), ["one"]);
	assert.equal((await aliases.POST(f.request("primary", path, "POST", { localPart: "billing", domainId: "two" }), context("m-sam"))).status, 404);
	const created = await aliases.POST(f.request("primary", path, "POST", { localPart: "billing", domainId: "one" }), context("m-sam"));
	assert.equal(created.status, 200);
	const [alias] = (await created.json()).aliases;
	assert.equal(alias.localPart, "billing");
	assert.equal((await aliases.DELETE(f.request("primary", `${path}?aliasId=${alias.id}`, "DELETE"), context("m-sam"))).status, 200);
	assert.equal(f.sql.prepare("SELECT count(*) AS count FROM mailbox_aliases").get().count, 0);
	assert.ok(f.calls.some(call => call.method === "DELETE"));
});

test("administrative avatar edits follow the mailbox owner's primary identity", async t => {
	const f = await fixture(t);
	const response = await avatar.GET(f.request("primary", "/api/mailboxes/m-sam/avatar"), context("m-sam"));
	assert.equal(response.status, 200);
	assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
	for (const id of ["m-sam", "m-sales"]) {
		const form = new FormData();
		form.set("file", new File([new Uint8Array([4, 5])], "avatar.webp", { type: "image/webp" }));
		form.set("preview", new File([new Uint8Array([6])], "preview.webp", { type: "image/webp" }));
		assert.equal((await avatar.POST(f.request("primary", `/api/mailboxes/${id}/avatar`, "POST", form), context(id))).status, 200);
	}
	assert.equal(f.sql.prepare("SELECT avatar_key FROM users WHERE id='sam'").get().avatar_key, "avatars/sam");
	assert.equal(f.sql.prepare("SELECT avatar_key FROM mailboxes WHERE id='m-sam'").get().avatar_key, "avatars/sam");
	assert.equal(f.sql.prepare("SELECT avatar_key FROM mailboxes WHERE id='m-sales'").get().avatar_key, "mailbox-avatars/m-sales");
	assert.deepEqual([...f.objects.get("avatars/sam")], [4, 5]);
	assert.equal(f.objects.has("mailbox-avatars/m-sales:preview"), true);
});

test("configuration access does not grant message access, sending rights or shared membership management", async t => {
	const f = await fixture(t);
	for (const actor of ["primary", "manager"]) {
		assert.equal((await f.patch(actor, "m-sam", { signature: "Managed signature" })).status, 200);
		const row = f.sql.prepare("SELECT id, role FROM users WHERE id=?").get(actor);
		assert.equal(await getMailboxAccessLevel(f.db, row, "m-sam"), null);
		assert.equal((await listAccessibleMailboxIds(f.db, { ...row, email: `${actor}@one.test` })).includes("m-sam"), false);
		await assert.rejects(getAuthorizedSenderAddress(f.env, { userId: actor, mailboxId: "m-sam", from: "sam@one.test" }), /permission to send/);
	}
	const shared = await f.read("primary", "m-shared");
	assert.equal((await shared.json()).mailbox.canManageSharing, true);
	const foreign = await f.patch("primary", "m-other-shared", { displayName: "Managed Team" });
	assert.equal(foreign.status, 200);
	const { mailbox } = await foreign.json();
	assert.equal(mailbox.canManageSharing, false);
	assert.equal(mailbox.permission, null);
	assert.equal(mailbox.displayName, "Managed Team");
	assert.equal(await getMailboxAccessLevel(f.db, { id: "primary", role: "admin" }, "m-other-shared"), null);
});
