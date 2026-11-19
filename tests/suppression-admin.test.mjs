import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-suppression-admin-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		admin: join(root, "src/lib/deliverability/suppression-admin.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const admin = await load("admin");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 1)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 1)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'other.org', 'zone', 1)").run();
	const insert = database.db.prepare("INSERT INTO email_suppressions (id, domain_id, email, reason, source, event_count, first_event_at, last_event_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)");
	const add = (id, domainId, email, reason = "hard_bounce", source = "ses", at = 100) => insert.run(id, domainId, email, reason, source, at, at);
	return { env: { DB: database }, add, raw: database.db };
}

test("lists one domain's entries, newest event first, with a total", async (t) => {
	const { env, add } = await createFixture(t);
	add("a", "d1", "old@x.org", "hard_bounce", "ses", 100);
	add("b", "d1", "new@x.org", "complaint", "resend", 300);
	add("c", "d2", "other@x.org");
	const result = await admin.listSuppressions(env, "d1", {});
	assert.equal(result.total, 2);
	assert.deepEqual(result.items.map((item) => item.email), ["new@x.org", "old@x.org"]);
	assert.deepEqual(Object.keys(result.items[0]).sort(), ["confirmed", "detail", "email", "eventCount", "firstEventAt", "id", "lastEventAt", "reason", "source"]);
});

test("search is a case-insensitive substring match and treats % and _ literally", async (t) => {
	const { env, add } = await createFixture(t);
	add("a", "d1", "anna@example.org");
	add("b", "d1", "bob_smith@example.org");
	add("c", "d1", "bobXsmith@example.org");
	assert.deepEqual((await admin.listSuppressions(env, "d1", { q: "ANNA" })).items.map((item) => item.email), ["anna@example.org"]);
	assert.deepEqual((await admin.listSuppressions(env, "d1", { q: "bob_smith" })).items.map((item) => item.email), ["bob_smith@example.org"]);
	assert.equal((await admin.listSuppressions(env, "d1", { q: "%" })).total, 0);
});

test("reason filter and paging, with the limit capped at 100", async (t) => {
	const { env, add } = await createFixture(t);
	for (let index = 0; index < 120; index += 1) add(`s${index}`, "d1", `u${String(index).padStart(3, "0")}@x.org`, index % 2 ? "complaint" : "hard_bounce", "ses", 1000 - index);
	assert.equal((await admin.listSuppressions(env, "d1", { reason: "complaint" })).total, 60);
	const first = await admin.listSuppressions(env, "d1", { limit: 500 });
	assert.equal(first.items.length, 100);
	assert.equal(first.total, 120);
	const rest = await admin.listSuppressions(env, "d1", { limit: 100, offset: 100 });
	assert.equal(rest.items.length, 20);
	assert.equal((await admin.listSuppressions(env, "d1", { reason: "bogus" })).total, 120);
});

test("remove deletes only an entry of that domain and reports whether it existed", async (t) => {
	const { env, add, raw } = await createFixture(t);
	add("a", "d1", "anna@example.org");
	add("b", "d2", "bob@example.org");
	assert.equal(await admin.removeSuppression(env, "d1", "b"), null, "another domain's id");
	assert.equal(raw.prepare("SELECT count(*) AS n FROM email_suppressions").get().n, 2);
	assert.deepEqual(await admin.removeSuppression(env, "d1", "a"), { email: "anna@example.org" });
	assert.equal(await admin.removeSuppression(env, "d1", "a"), null);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM email_suppressions").get().n, 1);
});

test("confirmSuppression confirms an unconfirmed entry of that domain only", async (t) => {
	const { env, add, raw } = await createFixture(t);
	add("a", "d1", "anna@x.org", "hard_bounce", "dsn");
	raw.prepare("UPDATE email_suppressions SET confirmed = 0").run();
	assert.equal(await admin.confirmSuppression(env, "d2", "a"), null, "another domain's id");
	assert.equal((await admin.listSuppressions(env, "d1", {})).items[0].confirmed, false);
	assert.deepEqual(await admin.confirmSuppression(env, "d1", "a"), { email: "anna@x.org" });
	assert.equal((await admin.listSuppressions(env, "d1", {})).items[0].confirmed, true);
});
