import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-creator-domain-test-"));
test.after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { POST as dashboardCreate } from "./src/app/api/accounts/route.ts";
			export { POST as apiCreate } from "./src/app/api/v1/accounts/route.ts";
		`,
		resolveDir: root,
		sourcefile: "account-creator-domain-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, createSession, generateApiKey, dashboardCreate, apiCreate } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, { canManageMailboxes = true } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1),
			('other', 'owner@foreign.test', 'hash', 'Other', 'admin', 0, 1);
		INSERT INTO users (id, email, password_hash, name, role, can_manage_mailboxes, can_manage_users, created_by_user_id, created_at)
			VALUES ('secondary', 'secondary@mailflare.test', 'hash', 'Delegate', 'admin', ${canManageMailboxes ? 1 : 0}, 1, 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'admin', 'one.test', 'zone-one', 'active', 1),
			('two', 'admin', 'two.test', 'zone-two', 'active', 1),
			('foreign', 'other', 'foreign.test', 'zone-foreign', 'active', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, features, updated_at)
			VALUES ('default', 'test-instance', 'team', 'active', '[]', 1);
	`);
	const key = generateApiKey();
	database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("key", "secondary", "Test", key.prefix, key.hash, '["accounts"]', 1);
	const env = { DB: database, CF_TOKEN: "test-only", MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const session = await createSession(env, "secondary");
	t.mock.method(globalThis, "fetch", async (url) => {
		const parsed = new URL(url);
		assert.equal(parsed.origin, "https://api.cloudflare.com", "tests must never contact a real service");
		assert.match(parsed.pathname, /^\/client\/v4\/zones\/[^/]+\/email\/routing\/rules\/?$/, parsed.pathname);
		return Response.json({ success: true, result: [] });
	});
	const post = (kind, overrides = {}) => {
		const handler = kind === "dashboard" ? dashboardCreate : apiCreate;
		return handler(new Request(`https://mailflare.test/api/${kind === "dashboard" ? "" : "v1/"}accounts`, {
			method: "POST",
			headers: { Authorization: `Bearer ${kind === "dashboard" ? session : key.fullKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ username: "sam", domainId: "one", password: "test-password", ...overrides }),
		}));
	};
	return { database, env, post };
}

for (const kind of ["dashboard", "api"]) {
	test(`${kind}: mailbox-manager admin creates accounts on creator-owned domains`, async (t) => {
		const f = await fixture(t);
		const response = await f.post(kind, { useAllDomains: false });
		assert.equal(response.status, 201);
		const email = (await response.json()).account.email;
		assert.equal(email, "sam@one.test");
		assert.equal(f.database.db.prepare("SELECT created_by_user_id FROM users WHERE email = ?").get(email).created_by_user_id, "secondary");
		// Aliases on another creator-owned domain work too.
		assert.equal((await f.post(kind, { username: "jane", domainId: "one", aliases: [{ domainId: "two", localPart: "billing" }], useAllDomains: false })).status, 201);
		// Foreign domains stay rejected.
		assert.equal((await f.post(kind, { username: "eve", domainId: "foreign" })).status, 404);
	});

	test(`${kind}: non-mailbox-manager admin cannot use creator-owned domains`, async (t) => {
		const f = await fixture(t, { canManageMailboxes: false });
		assert.equal((await f.post(kind, { useAllDomains: false })).status, 404);
		assert.equal(f.database.db.prepare("SELECT count(*) AS count FROM mailboxes WHERE local_part = 'sam'").get().count, 0);
	});
}
