import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-mysql-commit-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// mysql2 replaced by a connection that can fail its COMMIT, as a connection that just lost its session does.
const state = { commitFails: false, destroyed: false, released: false };
globalThis.__mysqlCommitState = state;
await build({
	entryPoints: [join(root, "src/db/drivers/mysql.ts")],
	outfile: join(directory, "mysql.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "fake-mysql2",
		setup(builder) {
			builder.onResolve({ filter: /^mysql2\/promise$/ }, () => ({ path: "mysql2", namespace: "fake" }));
			builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
				loader: "js",
				contents: `
					const state = globalThis.__mysqlCommitState;
					const connection = {
						beginTransaction: async () => {},
						commit: async () => { if (state.commitFails) throw new Error("connection lost"); },
						rollback: async () => {},
						query: async () => [[], []],
						destroy: () => { state.destroyed = true; },
						release: () => { state.released = true; },
					};
					export default { createPool: () => ({ getConnection: async () => connection, end: async () => {} }) };
				`,
			}));
		},
	}],
});
const { openMysql2 } = await import(pathToFileURL(join(directory, "mysql.mjs")).href);
const executor = () => openMysql2({ url: "mysql://x/y", shared: true });

test("a COMMIT that fails on a connection already marked broken does not fail finished work", async () => {
	Object.assign(state, { commitFails: true, destroyed: false, released: false });
	const result = await executor().transaction(async (tx) => {
		tx.discard();
		return "done";
	});
	assert.equal(result, "done");
	assert.equal(state.destroyed, true);
});

test("a COMMIT that fails on a healthy connection still throws", async () => {
	Object.assign(state, { commitFails: true, destroyed: false, released: false });
	await assert.rejects(executor().transaction(async () => "done"), /connection lost/);
});
