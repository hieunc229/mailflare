import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("auth-expired-purge", `
	export { purgeExpiredAuthRows } from "./src/lib/auth/purge.ts";
`);

const NOW = new Date("2026-01-01T00:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const TABLES = ["sessions", "login_challenges", "password_reset_tokens", "passkey_enrollment_grants"];

async function seed(t) {
	const fixture = await newDatabase(t, "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.com', 'x', 'U', 'user', 1);");
	// Inserts `count` rows per table: ids `<prefix>0..`, expiring `offset` seconds from NOW.
	fixture.add = (table, prefix, count, offset) => {
		const extra = table === "passkey_enrollment_grants" ? ", 'setup'" : "";
		const extraColumn = table === "passkey_enrollment_grants" ? ", kind" : "";
		fixture.sqlite.prepare(`
			WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
			INSERT INTO ${table} (id, user_id, token_hash, expires_at, created_at${extraColumn})
			SELECT ? || i, 'u1', ? || i, ?, 1${extra} FROM n`).run(count, prefix, `${table}-${prefix}`, nowSeconds + offset);
	};
	fixture.count = (table) => fixture.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
	return fixture;
}

test("expired rows go from every table; live rows and a row expiring exactly now stay", async (t) => {
	const fixture = await seed(t);
	for (const table of TABLES) {
		fixture.add(table, "old", 3, -60);
		fixture.add(table, "edge", 1, 0);
		fixture.add(table, "live", 2, 60);
	}
	await app.purgeExpiredAuthRows(fixture.env, NOW);
	for (const table of TABLES) {
		assert.deepEqual(fixture.sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id), ["edge0", "live0", "live1"], table);
	}
});

test("one run removes at most 50 batches of 90 per table", async (t) => {
	const fixture = await seed(t);
	fixture.add("sessions", "old", 4600, -60);
	// Every DELETE must bind at most 90 ids, under D1's 100-parameter limit.
	const bound = [];
	const prepare = fixture.env.DB.prepare.bind(fixture.env.DB);
	t.mock.method(fixture.env.DB, "prepare", (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => { if (/^\s*delete/i.test(sql)) bound.push(values.length); return bind(...values); };
		return statement;
	});
	await app.purgeExpiredAuthRows(fixture.env, NOW);
	assert.equal(fixture.count("sessions"), 100);
	assert.deepEqual(bound, Array(50).fill(90));
	await app.purgeExpiredAuthRows(fixture.env, NOW);
	assert.equal(fixture.count("sessions"), 0);
});

test("a failing table does not stop the others", async (t) => {
	const fixture = await seed(t);
	fixture.add("sessions", "old", 5, -60);
	fixture.add("login_challenges", "old", 5, -60);
	fixture.sqlite.exec("CREATE TRIGGER block_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
	t.mock.method(console, "error", () => {});
	await app.purgeExpiredAuthRows(fixture.env, NOW);
	assert.equal(fixture.count("login_challenges"), 0);
	assert.equal(fixture.count("sessions"), 5);
});
