import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// D1 rejects a statement with more than 100 bound parameters, and a thread view
// loads up to 200 messages, so its per-message lookups must be chunked.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-thread-view-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: { contents: `
		export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
		export { applyMigrations } from "./server/runtime/migrate.ts";
		export { getDb, schema } from "./src/db/index.ts";
		export { getMessageThreadForUser } from "./src/lib/email/thread-view.ts";
	`, resolveDir: root, sourcefile: "thread-entry.ts" },
	outfile: join(directory, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external", logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, schema, getMessageThreadForUser } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("a 120-message thread opens without binding more than 100 parameters in one statement", async (t) => {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.pragma("foreign_keys = OFF");
	const db = getDb({ DB: database });
	await db.insert(schema.mailboxes).values({ id: "mb1", userId: "u1", domainId: "d1", localPart: "a", address: "a@x.test" });
	const base = { userId: "u1", mailboxId: "mb1", direction: "inbound", toAddr: "a@x.test", subject: "Re: build", threadId: "t1" };
	const rows = Array.from({ length: 120 }, (_, i) => ({ ...base, id: `m${i}`, fromAddr: `p${i}@y.test`, createdAt: new Date(1_700_000_000_000 + i * 1000) }));
	for (let i = 0; i < rows.length; i += 5) await db.insert(schema.messages).values(rows.slice(i, i + 5));

	// Enforce D1's limit the way Cloudflare does.
	const counts = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			counts.push(values.length);
			if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
			return bind(...values);
		};
		return statement;
	};
	const result = await getMessageThreadForUser({ DB: database }, { id: "u1", role: "admin" }, "m0");
	assert.ok(result);
	assert.ok(Math.max(...counts) <= 100, `a statement bound ${Math.max(...counts)} parameters`);
	assert.equal(result.messages?.length ?? result.length, 120);
});

test("bodies none leaves bodies out of the query and the result; default keeps them", async (t) => {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.pragma("foreign_keys = OFF");
	const db = getDb({ DB: database });
	await db.insert(schema.mailboxes).values({ id: "mb1", userId: "u1", domainId: "d1", localPart: "a", address: "a@x.test" });
	const base = { userId: "u1", mailboxId: "mb1", direction: "inbound", toAddr: "a@x.test", subject: "Re: build", threadId: "t1" };
	await db.insert(schema.messages).values([
		{ ...base, id: "a", fromAddr: "p@y.test", textBody: "BODY-A", htmlBody: "<p>BODY-A</p>", createdAt: new Date(1_700_000_000_000) },
		{ ...base, id: "b", fromAddr: "q@y.test", textBody: "BODY-B", htmlBody: "<p>BODY-B</p>", createdAt: new Date(1_700_000_001_000) },
	]);
	const sql = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (text) => { sql.push(text); return prepare(text); };
	const user = { id: "u1", role: "admin" };

	const lean = await getMessageThreadForUser({ DB: database }, user, "a", { bodies: "none" });
	assert.equal(lean.messages.length, 2);
	for (const message of lean.messages) {
		assert.equal(message.textBody, null);
		assert.equal(message.htmlBody, null);
		assert.equal(message.bodyOmitted, true);
		assert.equal("rawR2Key" in message, false);
		assert.equal(message.subject, "Re: build");
	}
	const threadSelect = sql.filter((text) => /from "messages"/i.test(text) && /order by/i.test(text));
	assert.ok(threadSelect.length > 0);
	for (const text of threadSelect) assert.doesNotMatch(text, /"text_body"|"html_body"/);

	const full = await getMessageThreadForUser({ DB: database }, user, "a");
	assert.equal(full.messages.find((m) => m.id === "b").textBody, "BODY-B");
	assert.equal(full.messages.find((m) => m.id === "b").bodyOmitted, undefined);
	// Same access check: a user without mailbox access gets nothing either way.
	assert.equal(await getMessageThreadForUser({ DB: database }, { id: "u2", role: "user" }, "a", { bodies: "none" }), null);
});
