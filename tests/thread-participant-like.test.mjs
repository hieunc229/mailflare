import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-thread-participant-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { resolveThreadId } from "./src/lib/email/threading.ts";
		`,
		resolveDir: root,
		sourcefile: "thread-participant-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, resolveThreadId } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, fromAddr) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("PRAGMA foreign_keys = OFF");
	database.db
		.prepare(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, thread_id, provider_message_id, status, created_at)
			 VALUES ('m1', 'u1', 'mb1', 'inbound', ?, 'me@x.com', 'thr-1', 'parent@x.com', 'received', 1)`,
		)
		.run(fromAddr);
	return getDb({ DB: database });
}

const reply = (senderAddress) => ({ mailboxId: "mb1", inReplyTo: "<parent@x.com>", senderAddress, messageId: "<child@x.com>" });

test("a reply from an existing participant joins the thread, including addresses with ! _ or %", async (t) => {
	for (const address of ["a!b@x.com", "no_reply@x.com", "50%@x.com", "plain@x.com"]) {
		const db = await fixture(t, address);
		assert.equal(await resolveThreadId(db, reply(address.toUpperCase())), "thr-1", address);
	}
});

test("a sender that only matches through a wildcard does not join the thread", async (t) => {
	const db = await fixture(t, "noXreply@x.com");
	assert.notEqual(await resolveThreadId(db, reply("no_reply@x.com")), "thr-1");
	const other = await fixture(t, "someone@x.com");
	assert.notEqual(await resolveThreadId(other, reply("%")), "thr-1");
});
