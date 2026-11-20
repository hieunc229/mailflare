import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-contact-source-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { analyzeSpam } from "./src/lib/spam/engine.ts";
			export { unfamiliarRecipients } from "./src/lib/agent/approvals/utils.ts";
			export { upsertContactFromAddress, upsertContactsFromAddresses } from "./src/lib/contacts/service.ts";
			export { getPartyDisplayName } from "./src/lib/contacts/utils.ts";
		`,
		resolveDir: root,
		sourcefile: "contact-source-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node24",
	tsconfig: join(root, "tsconfig.json"), packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, analyzeSpam, unfamiliarRecipients, upsertContactFromAddress, upsertContactsFromAddresses, getPartyDisplayName } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, source) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@one.test', 'hash', 'U', 'admin', 1);
		INSERT INTO contacts (id, user_id, email, display_name, source, blocked, remote_content_allowed, created_at)
			VALUES ('u1:pal@x.test', 'u1', 'pal@x.test', 'Pal', '${source}', 0, 0, 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	return { env, db: getDb(env), sql: database.db };
}

const message = { subject: "Hi", text: "Hello there", html: null, messageId: null, fromAddr: "Pal <pal@x.test>", toAddr: "u1@one.test", ccAddr: null, bccAddr: null, replyTo: null, inReplyTo: null, references: [], date: null, attachments: [] };
const signalIds = async (f) => (await analyzeSpam(f.db, { mailboxId: "m1", userId: "u1", envelopeFrom: "pal@x.test", message })).signals.map((signal) => signal.id);

test("an imported contact counts as a saved contact for the spam score, like a manual one", async (t) => {
	for (const source of ["manual", "import"]) assert.ok((await signalIds(await fixture(t, source))).includes("manual_contact"), source);
	assert.ok(!(await signalIds(await fixture(t, "inbound"))).includes("manual_contact"));
});

test("an imported address is a familiar recipient for agent sends, like a manual one", async (t) => {
	const snapshot = { to: "pal@x.test, stranger@y.test", cc: null, bcc: null };
	for (const source of ["manual", "import"]) assert.deepEqual(await unfamiliarRecipients((await fixture(t, source)).env, "u1", snapshot), ["stranger@y.test"], source);
	assert.deepEqual(await unfamiliarRecipients((await fixture(t, "inbound")).env, "u1", snapshot), ["pal@x.test", "stranger@y.test"]);
});

test("an imported name wins over the message header name, like a manual one", () => {
	assert.equal(getPartyDisplayName('"Header" <pal@x.test>', { displayName: "Pal", source: "import" }), "Pal");
	assert.equal(getPartyDisplayName('"Header" <pal@x.test>', { displayName: "Pal", source: "inbound" }), "Header");
});

test("mail from or to an imported contact neither renames it nor changes its source", async (t) => {
	const f = await fixture(t, "import");
	await upsertContactFromAddress(f.env, { userId: "u1", address: "New Name <pal@x.test>", source: "inbound", lookupAvatar: false });
	await upsertContactFromAddress(f.env, { userId: "u1", address: "Other <pal@x.test>", source: "outbound", lookupAvatar: false });
	await upsertContactsFromAddresses(f.env, "u1", ["Third <pal@x.test>"], "outbound");
	assert.deepEqual({ ...f.sql.prepare("SELECT display_name, source FROM contacts WHERE id='u1:pal@x.test'").get() }, { display_name: "Pal", source: "import" });
});
