import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

// C-1: code that needs a batch to be all-or-nothing asks `db.batchIsAtomic`. Only a driver with no transaction (Neon over HTTP) answers false,
// and the real executors say so without touching the network.
const entry = await loadFixture({ name: "db-batch-atomic", entryPoint: "src/db/external.ts", mocks: {} });
const config = await loadFixture({ name: "db-batch-atomic-config", entryPoint: "src/db/dialect.ts", mocks: {} });
const { openExternalDatabase } = await entry.import();
const { resolveDatabaseConfig } = await config.import();
after(() => { entry.dispose(); config.dispose(); });

const atomic = (url, driver) => {
	const resolved = resolveDatabaseConfig({ DATABASE_URL: url, ...(driver ? { DATABASE_DRIVER: driver } : {}) });
	const database = openExternalDatabase(resolved, false);
	return { driver: resolved.driver, flag: database.createDrizzle({}).batchIsAtomic, executor: database.sqlExecutor.atomicBatch };
};

test("Neon over HTTP is not atomic, by its own declaration", () => {
	for (const url of ["postgres://u:p@ep-1.neon.tech/db", "postgres://u:p@host.example/db"]) {
		const result = atomic(url, "neon");
		assert.equal(result.driver, "neon");
		assert.equal(result.flag, false, url);
		assert.equal(result.executor, false);
	}
});

test("every other driver that can be built offline is atomic", () => {
	for (const [url, driver] of [["postgres://u:p@host.example/db", "node-postgres"], ["postgres://u:p@host.example/db", "postgres-js"], ["pglite://memory", "pglite"], ["mysql://u:p@host.example/db", "mysql2"], ["file::memory:", "better-sqlite3"], ["libsql://x.turso.io", "libsql"], ["mysql://u:p@host.example/db", "planetscale"]]) {
		const result = atomic(url, driver);
		assert.equal(result.flag, true, `${result.driver}`);
	}
});
