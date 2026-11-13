import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after } from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bundle app modules (a list of `export ... from "./src/..."` lines) with the runtime SQLite
// driver and migrate helper, and import the result. The returned `newDatabase` applies the real
// migrations to an in-memory database, so tests exercise actual queries on the real schema.
export async function loadApp(name, exportLines, { mocks = {} } = {}) {
	const directory = mkdtempSync(join(root, "node_modules", `${name}-test-`));
	after(() => rmSync(directory, { recursive: true, force: true }));
	await build({
		stdin: {
			contents: `
				export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
				export { applyMigrations } from "./server/runtime/migrate.ts";
				export { getDb } from "./src/db/index.ts";
				${exportLines}
			`,
			resolveDir: root,
			sourcefile: `${name}-entry.ts`,
		},
		outfile: join(directory, "entry.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		tsconfig: join(root, "tsconfig.json"),
		packages: "external",
		alias: {
			"next/headers": "next/headers.js",
			"next/server": "next/server.js",
			"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
		},
		logLevel: "silent",
		plugins: [{
			name: `${name}-mocks`,
			setup(builder) {
				builder.onResolve({ filter: /.*/ }, ({ path }) => (path in mocks ? { path, namespace: "mock" } : undefined));
				builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
			},
		}],
	});
	const app = await import(pathToFileURL(join(directory, "entry.mjs")).href);
	async function newDatabase(t, seedSql = "") {
		const database = new app.SqliteDatabase(":memory:");
		t.after(() => database.db.close());
		await app.applyMigrations(database, join(root, "drizzle", "migrations"));
		database.db.exec(seedSql);
		return { env: { DB: database }, sqlite: database.db, db: app.getDb({ DB: database }) };
	}
	return { app, newDatabase };
}

// owner (own personal mailbox), admin (owns shared mailbox "team"), and the team plan enabled.
// `delegate` has the given permission on the shared mailbox and owns a personal mailbox of their own.
export function sharedMailboxSeed(delegatePermission) {
	return `
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
			('delegate', 'delegate@example.com', 'hash', 'Delegate', 'user', 1),
			('author', 'author@example.com', 'hash', 'Author', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'admin', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mb-delegate', 'delegate', 'domain-1', 'delegate', 'personal', 1),
			('mb-admin', 'admin', 'domain-1', 'admin', 'personal', 1),
			('mb-team', 'admin', 'domain-1', 'team', 'shared', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('acc-1', 'mb-team', 'delegate', '${delegatePermission}', 1),
			('acc-2', 'mb-team', 'author', 'send_on_behalf', 1);
	`;
}
