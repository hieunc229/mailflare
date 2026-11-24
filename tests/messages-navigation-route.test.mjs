import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-messages-navigation-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.navigationRouteFixture;
});
const mocks = {
	"@/lib/cloudflare": "export function getEnv() { return globalThis.navigationRouteFixture.env; }",
	"@/lib/auth/cookies": "export async function getCurrentUser() { return globalThis.navigationRouteFixture.user; }",
};
await build({
	entryPoints: {
		route: join(root, "src/app/api/messages/navigation/route.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	plugins: [{
		name: "navigation-route-fixtures",
		setup(builder) {
			builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server.js", external: true }));
			builder.onResolve({ filter: /^@\/lib\// }, (args) => args.path in mocks ? { path: args.path, namespace: "mock" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});
const { GET } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);
const request = (query) => new Request(`https://mail.example/api/messages/navigation?${query}`);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES
			('owner', 'owner@example.com', 'Owner', 'x', 'admin', 0),
			('other', 'other@example.com', 'Other', 'x', 'user', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'owner', 'example.com', 'zone', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
			('mine', 'owner', 'domain', 'owner', 'personal', 0, 0),
			('shared', 'other', 'domain', 'shared', 'shared', 0, 0);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('grant', 'shared', 'owner', 'read_only', 0);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'test', 'team', 'active', 0);
	`);
	globalThis.navigationRouteFixture = {
		env: { DB: database },
		user: { id: "owner", email: "owner@example.com", name: "Owner", role: "admin" },
	};
	return {
		message(id, { mailbox = "mine", user = "owner", thread = "thread", read = false, time = 1 } = {}) {
			database.db.prepare(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, thread_id, snippet, text_body, html_body, raw_r2_key, created_at)
				VALUES (?, ?, ?, 'inbound', 'friend@example.com', 'owner@example.com', 'received', ?, ?, 'preview', 'body', '<p>body</p>', 'raw-key', ?)`).run(id, user, mailbox, Number(read), thread, time);
		},
	};
}

test("all-mailbox navigation stops at each mailbox's copy of a shared thread", async (t) => {
	const f = await fixture(t);
	f.message("mine-first", { time: 1 });
	f.message("shared-copy", { mailbox: "shared", user: "other", time: 2 });
	f.message("mine-reply", { time: 3, read: true });

	const all = await (await GET(request("folder=inbox&group=thread"))).json();
	assert.deepEqual(all.messages, [
		{ id: "mine-reply", unread: true },
		{ id: "shared-copy", unread: true },
	]);

	const single = await (await GET(request("folder=inbox&group=thread&mailboxId=mine"))).json();
	assert.deepEqual(single.messages, [{ id: "mine-reply", unread: true }]);
});
