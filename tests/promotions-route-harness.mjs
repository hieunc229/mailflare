import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Bundles the given entry source against the real app code; only the session lookup is replaced. */
/** `mocks` maps a module specifier to replacement source, for network and provider calls a test must not make. */
export async function loadRoutes(name, contents, mocks = {}) {
	const directory = mkdtempSync(join(root, "node_modules", `mailflare-${name}-`));
	after(() => rmSync(directory, { recursive: true, force: true }));
	await build({
		stdin: {
			contents: `export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";\nexport { applyMigrations } from "./server/runtime/migrate.ts";\n${contents}`,
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
		alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
		plugins: [{
			name: "session",
			setup(builder) {
				builder.onResolve({ filter: /^@\/lib\/auth\/cookies$/ }, (args) => ({ path: args.path, namespace: "mock" }));
				builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export async function getCurrentUser(){return globalThis.__testUser}", loader: "js" }));
				for (const specifier of Object.keys(mocks)) {
					builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")}$`) }, (args) => ({ path: args.path, namespace: "mock-module" }));
				}
				builder.onLoad({ filter: /.*/, namespace: "mock-module" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
			},
		}],
		logLevel: "silent",
	});
	return import(pathToFileURL(join(directory, "entry.mjs")).href);
}

export const OWNER = { id: "u", role: "admin", email: "o@one.test", timeZone: "UTC" };
export const DELEGATE = { id: "r", role: "user", email: "r@one.test", timeZone: "UTC" };

/** Owner `u` with mailbox `a` (own) and shared mailbox `s` where user `r` holds `delegatePermission`. */
export async function seed(t, m, { delegatePermission = "read_only", migrations = join(root, "drizzle/migrations"), user = OWNER } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, migrations);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1), ('r', 'r@one.test', 'h', 'R', 'user', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'u', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('a', 'u', 'd', 'a', 'personal', 1), ('s', 'u', 'd', 's', 'shared', 1);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'i', 'team', 'active', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('x', 's', 'r', '${delegatePermission}', 1);
	`);
	globalThis.__mailflareNodeEnv = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__testUser = user;
	t.after(() => { delete globalThis.__mailflareNodeEnv; delete globalThis.__testUser; });
	return database;
}

export const as = (user) => { globalThis.__testUser = user; };

export function request(url, { method = "GET", body, origin = true } = {}) {
	const headers = new Headers();
	if (origin) headers.set("Sec-Fetch-Site", "same-origin");
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return new Request(`https://mail.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function call(handler, req, params) {
	const response = await handler(req, params ? { params: Promise.resolve(params) } : undefined);
	return { status: response.status, body: await response.json() };
}
