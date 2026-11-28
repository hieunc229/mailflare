import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-database-dialects-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		dialect: join(root, "src/db/dialect.ts"),
		drivers: join(root, "src/db/drivers/types.ts"),
		backups: join(root, "src/lib/backups/export.ts"),
		inspect: join(root, "tests/fixtures/inspect-schema.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	packages: "external",
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { resolveDatabaseConfig, inferDriver, schemaDialect } = await load("dialect");
const { numberPlaceholders, normalizeParam } = await load("drivers");
const { BACKUP_TABLES, INTERNAL_TABLES, INTERNAL_TABLE_PATTERNS } = await load("backups");

test("no DATABASE_URL keeps D1", () => {
	assert.deepEqual(resolveDatabaseConfig({}), { dialect: "sqlite", driver: "d1" });
	assert.deepEqual(resolveDatabaseConfig({ DATABASE_DRIVER: "d1" }), { dialect: "sqlite", driver: "d1" });
	assert.deepEqual(resolveDatabaseConfig({ DATABASE_URL: "  " }), { dialect: "sqlite", driver: "d1" });
});

test("drivers are inferred from the connection string", () => {
	const cases = [
		["postgres://u:p@db.example.com/app", "node-postgres", "postgres"],
		["postgresql://u:p@db.supabase.co:5432/postgres", "node-postgres", "postgres"],
		["postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/app?sslmode=require", "neon", "postgres"],
		["pglite://./data/pg", "pglite", "postgres"],
		["mysql://u:p@db.example.com/app", "mysql2", "mysql"],
		["mysql://u:p@aws.connect.psdb.cloud/app", "planetscale", "mysql"],
		["mariadb://u:p@db.example.com/app", "mysql2", "mysql"],
		["libsql://mailflare-me.turso.io", "libsql", "sqlite"],
		["https://mailflare-me.turso.io", "libsql", "sqlite"],
		["file:./data/mailflare.db", "better-sqlite3", "sqlite"],
	];
	for (const [url, driver, dialect] of cases) {
		assert.equal(inferDriver(url), driver, url);
		assert.deepEqual(resolveDatabaseConfig({ DATABASE_URL: url }), { dialect, driver, url, authToken: undefined }, url);
	}
});

test("DATABASE_DRIVER overrides inference and accepts aliases", () => {
	assert.equal(resolveDatabaseConfig({ DATABASE_URL: "postgres://h/db", DATABASE_DRIVER: "postgres-js" }).driver, "postgres-js");
	assert.equal(resolveDatabaseConfig({ DATABASE_URL: "postgres://h/db", DATABASE_DRIVER: "supabase" }).driver, "node-postgres");
	assert.equal(resolveDatabaseConfig({ DATABASE_URL: "postgres://h/db", DATABASE_DRIVER: "vercel" }).driver, "neon");
	assert.equal(resolveDatabaseConfig({ DATABASE_URL: "mysql://h/db", DATABASE_DRIVER: "tidb" }).driver, "mysql2");
	assert.equal(resolveDatabaseConfig({ DATABASE_URL: "libsql://h", DATABASE_AUTH_TOKEN: "t" }).authToken, "t");
	assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: "postgres://h/db", DATABASE_DRIVER: "oracle" }), /Unsupported DATABASE_DRIVER/);
	assert.throws(() => resolveDatabaseConfig({ DATABASE_DRIVER: "pglite" }), /needs DATABASE_URL/);
	assert.throws(() => inferDriver("ftp://nope"), /Cannot infer/);
});

test("a Hyperdrive binding supplies the connection string", () => {
	const config = resolveDatabaseConfig({ DATABASE_DRIVER: "node-postgres" }, "postgres://hyperdrive/db");
	assert.equal(config.url, "postgres://hyperdrive/db");
	assert.equal(config.dialect, "postgres");
});

test("the schema dialect follows the environment", () => {
	const original = { ...process.env };
	try {
		delete process.env.DATABASE_URL;
		delete process.env.DATABASE_DRIVER;
		delete process.env.MAILFLARE_DB_DIALECT;
		assert.equal(schemaDialect(), "sqlite");
		process.env.DATABASE_URL = "postgres://h/db";
		assert.equal(schemaDialect(), "postgres");
		process.env.DATABASE_URL = "mysql://h/db";
		assert.equal(schemaDialect(), "mysql");
		process.env.MAILFLARE_DB_DIALECT = "postgres";
		assert.equal(schemaDialect(), "postgres");
		process.env.MAILFLARE_DB_DIALECT = "oracle";
		assert.throws(() => schemaDialect(), /MAILFLARE_DB_DIALECT/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
		Object.assign(process.env, original);
	}
});

test("placeholders are numbered outside literals and comments only", () => {
	assert.equal(numberPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2");
	assert.equal(numberPlaceholders("SELECT '?' , \"a?b\", ? -- why?\n, ?"), "SELECT '?' , \"a?b\", $1 -- why?\n, $2");
	assert.equal(numberPlaceholders("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
});

test("parameters are normalised for every driver", () => {
	assert.equal(normalizeParam(undefined), null);
	assert.equal(normalizeParam(new Date(1_700_000_000_500)), 1_700_000_000);
	assert.equal(normalizeParam("x"), "x");
	assert.ok(normalizeParam(new ArrayBuffer(2)) instanceof Uint8Array);
});

function inspect(dialect) {
	const result = spawnSync(process.execPath, [join(outDir, "inspect.mjs")], { env: { ...process.env, MAILFLARE_DB_DIALECT: dialect }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const schemas = { sqlite: inspect("sqlite"), postgres: inspect("postgres"), mysql: inspect("mysql") };

test("every dialect defines the same tables and columns", () => {
	const names = (schema) => Object.keys(schema).sort();
	assert.deepEqual(names(schemas.postgres), names(schemas.sqlite));
	assert.deepEqual(names(schemas.mysql), names(schemas.sqlite));
	for (const table of names(schemas.sqlite)) {
		const columns = (schema) => schema[table].columns.map((column) => column.name);
		assert.deepEqual(columns(schemas.postgres), columns(schemas.sqlite), table);
		assert.deepEqual(columns(schemas.mysql), columns(schemas.sqlite), table);
	}
});

test("MySQL never indexes a TEXT column", () => {
	for (const [table, { columns, indexed }] of Object.entries(schemas.mysql)) {
		for (const name of indexed) {
			const column = columns.find((candidate) => candidate.name === name);
			assert.ok(column, `${table}.${name}`);
			assert.notEqual(column.sqlType, "longtext", `${table}.${name} is indexed but LONGTEXT`);
		}
	}
});

test("MySQL keeps audit_logs.action as longtext, as installed; its index there is a prefix index made by migration", () => {
	const { columns, indexed } = schemas.mysql.audit_logs;
	assert.equal(columns.find((column) => column.name === "action").sqlType, "longtext");
	assert.equal(indexed.includes("action"), false);
	assert.ok(schemas.postgres.audit_logs.indexed.includes("action"));
});

test("MySQL does not declare the thread-key indexes its migration drops; the other dialects keep them", () => {
	for (const name of ["messages_thread_key_idx", "messages_mailbox_thread_key_idx"]) {
		assert.equal(schemas.mysql.messages.indexNames.includes(name), false, name);
		assert.ok(schemas.postgres.messages.indexNames.includes(name), name);
		assert.ok(schemas.sqlite.messages.indexNames.includes(name), name);
	}
});

test("MySQL keeps every index under the InnoDB key size limit", () => {
	for (const [table, { indexBytes }] of Object.entries(schemas.mysql)) {
		for (const [name, bytes] of Object.entries(indexBytes)) assert.ok(bytes <= 3072, `${table}.${name} is ${bytes} bytes`);
	}
});

const migrationTables = (directory) =>
	new Set(
		readdirSync(join(root, directory))
			.filter((name) => name.endsWith(".sql"))
			.flatMap((name) => [...readFileSync(join(root, directory, name), "utf8").matchAll(/CREATE TABLE [`"]?(\w+)[`"]?/gi)].map((match) => match[1])),
	);

for (const [dialect, directory] of [["postgres", "drizzle/migrations-pg"], ["mysql", "drizzle/migrations-mysql"], ["sqlite", "drizzle/migrations"]]) {
	// SQLite's history includes tables later dropped; its coverage is checked by backup-table-list.test.mjs.
	const replayable = dialect !== "sqlite";
	test(`${dialect} migrations create the schema tables`, { skip: !replayable }, () => {
		const created = migrationTables(directory);
		for (const table of Object.keys(schemas[dialect])) assert.ok(created.has(table), `${table} is missing from ${directory}`);
	});

	test(`${dialect} backups cover every migrated table`, { skip: !replayable }, () => {
		const created = [...migrationTables(directory)].filter(
			(name) => !INTERNAL_TABLES.includes(name) && !INTERNAL_TABLE_PATTERNS.some((pattern) => name.startsWith(pattern.replace(/%$/, ""))),
		);
		assert.deepEqual(created.filter((name) => !BACKUP_TABLES.includes(name)), []);
		assert.deepEqual(BACKUP_TABLES.filter((name) => !created.includes(name)), []);
	});

	test(`${dialect} migration bundle matches the SQL files`, () => {
		const file = dialect === "sqlite" ? "bundle.json" : `bundle-${dialect}.json`;
		const bundle = JSON.parse(readFileSync(join(root, "src/lib/migrations", file), "utf8"));
		const names = readdirSync(join(root, directory)).filter((name) => name.endsWith(".sql")).sort();
		assert.deepEqual(bundle.migrations.map((migration) => migration.name), names, "run `npm run db:bundle`");
		for (const migration of bundle.migrations) assert.ok(migration.statements.length > 0, migration.name);
	});
}

test("PostgreSQL and MySQL ship the triggers SQLite has", () => {
	for (const directory of ["drizzle/migrations-pg", "drizzle/migrations-mysql"]) {
		const sql = readFileSync(join(root, directory, "0001_triggers_and_seeds.sql"), "utf8");
		for (const needle of ["jmap_changes", "jmap_mailbox_revisions", "trashed_at", "jmap_change_floor", "app_settings", "backup_settings"]) {
			assert.ok(sql.includes(needle), `${directory} lacks ${needle}`);
		}
	}
});
