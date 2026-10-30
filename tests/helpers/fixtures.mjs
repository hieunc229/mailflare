import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bundle one app module with literal module mocks and import it. Call dispose()
// once the test file's last import is done so the temporary directory is removed.
export async function loadFixture({ name, entryPoint, mocks }) {
	const temporary = mkdtempSync(join(root, "node_modules", `${name}-test-`));
	await build({
		entryPoints: [join(root, entryPoint)],
		outfile: join(temporary, "fixture.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		alias: { "@": join(root, "src") },
		logLevel: "silent",
		plugins: [{ name: `${name}-fixtures`, setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => path in mocks ? { path, namespace: "mock" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		} }],
	});
	return {
		import: () => import(pathToFileURL(join(temporary, "fixture.mjs")).href),
		dispose: () => rmSync(temporary, { recursive: true, force: true }),
	};
}

// An in-memory SQLite database behind drizzle's sqlite-proxy driver. The hooks
// let a test inject a competing write immediately before or after a query.
export function sqliteProxy({ schema = "", beforeQuery, afterQuery } = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schema);
	const db = drizzle(async (sql, params, method) => {
		beforeQuery?.(sql, sqlite);
		const query = sqlite.prepare(sql);
		let rows;
		if (method === "run") {
			query.run(...params);
			rows = [];
		} else {
			query.setReturnArrays(true);
			rows = query.all(...params);
		}
		afterQuery?.(sql, sqlite);
		return { rows };
	});
	return { db, sqlite };
}

// Same as sqliteProxy, but expose it as globalThis[store] so the bundled mocks
// can reach it, and return the database for direct assertions.
export function installSqlite(store, { extra = {}, ...options } = {}) {
	const { db, sqlite } = sqliteProxy(options);
	globalThis[store] = { db, sqlite, ...extra };
	return sqlite;
}

// Inject `concurrent` just before an app write to the users password snapshot.
export function concurrentPasswordWrite(concurrent) {
	let pending = concurrent;
	return (sql, sqlite) => {
		if (pending && /update\s+"?users"?/i.test(sql) && /password_hash/i.test(sql)) {
			sqlite.exec(pending);
			pending = "";
		}
	};
}
