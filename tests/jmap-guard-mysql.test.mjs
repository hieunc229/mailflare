import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-guard-mysql-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { updateUnlessChangedSince } from "./src/lib/jmap/emails.ts";
			export { wrapDatabase } from "./src/db/compat.ts";
			export { schema } from "./src/db/schema/index.ts";
			export { drizzle as mysqlProxy } from "drizzle-orm/mysql-proxy";
			export { sql } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "jmap-guard-mysql-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { updateUnlessChangedSince, wrapDatabase, schema, mysqlProxy, sql } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** A MySQL-speaking database whose executor records every statement; `logged` answers the change-log read. */
function fakeMysql(logged) {
	const statements = [];
	const events = [];
	const executor = {
		dialect: "mysql",
		async query(text, params) {
			statements.push({ text, params, tx: ctx.tx !== null });
			if (/^select object_id from jmap_changes/i.test(text)) return { rows: params.filter((value) => logged.includes(value)).map((id) => ({ object_id: id })), affectedRows: 0 };
			return { rows: [], affectedRows: 0 };
		},
		async transaction(fn) {
			events.push("begin");
			const result = await fn(executor);
			events.push("commit");
			return result;
		},
	};
	const ctx = { base: executor, tx: null };
	const base = executor.transaction.bind(executor);
	executor.transaction = (fn) => base((tx) => { ctx.tx = tx; return fn(tx); });
	const proxy = mysqlProxy(
		async (text, params, method) => {
			const result = await executor.query(text, params);
			return method === "all" ? { rows: result.rows } : { rows: [{ insertId: 0, affectedRows: result.affectedRows }], insertId: 0, affectedRows: result.affectedRows };
		},
		{ schema },
	);
	const db = wrapDatabase(proxy, "mysql", ctx);
	const env = { DB: { createDrizzle: () => db, config: { dialect: "mysql" } } };
	return { db, env, statements, events };
}

const guard = { mailboxId: "m1", jmapSeq: 7 };

test("on MySQL the guard is a locking read and a plain UPDATE in one transaction", async () => {
	const { db, env, statements, events } = fakeMysql(["b"]);
	const changed = await updateUnlessChangedSince(env, db, guard, ["a", "b", "c"], { read: sql`${schema.messages.read}` });
	assert.deepEqual([...changed], ["b"]);
	assert.deepEqual(events, ["begin", "commit"]);
	assert.equal(statements.length, 2);
	assert.ok(statements.every((statement) => statement.tx));
	const [read, write] = statements;
	assert.match(read.text, /^select object_id from jmap_changes where mailbox_id = \? and object_type = 'email' and object_id in \(\?, \?, \?\) and seq > \? lock in share mode$/);
	assert.deepEqual(read.params, ["m1", "a", "b", "c", 7]);
	assert.match(write.text, /^update `messages` set /);
	assert.ok(!/jmap_changes|select/i.test(write.text));
	assert.deepEqual(write.params.filter((value) => ["a", "b", "c"].includes(value)), ["a", "c"]);
});

test("on MySQL nothing is written when every id has a later change", async () => {
	const { db, env, statements } = fakeMysql(["a", "b"]);
	const changed = await updateUnlessChangedSince(env, db, guard, ["a", "b"], { read: sql`${schema.messages.read}` });
	assert.deepEqual([...changed].sort(), ["a", "b"]);
	assert.equal(statements.length, 1);
	assert.match(statements[0].text, /lock in share mode$/);
});

test("on MySQL long id lists are cut so no statement passes 100 parameters", async () => {
	const { db, env, statements, events } = fakeMysql([]);
	const ids = Array.from({ length: 250 }, (_, index) => `id${index}`);
	const changed = await updateUnlessChangedSince(env, db, guard, ids, { read: sql`${schema.messages.read}` });
	assert.equal(changed.size, 0);
	assert.deepEqual(events, ["begin", "commit"]);
	assert.equal(statements.length, 6);
	assert.ok(statements.every((statement) => statement.params.length <= 100));
});
