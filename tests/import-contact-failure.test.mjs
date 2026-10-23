import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-import-contact-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		service: join(root, "src/lib/import/service.ts"),
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
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { importMessagesToMailbox, describeImportError } = await load("service");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const raw = new TextEncoder().encode([
	"From: Kevin <kevin@example.com>",
	"To: Iris <iris@example.org>",
	"Subject: Offer",
	"Message-ID: <offer-1@example.com>",
	"Date: Tue, 2 Feb 2021 10:00:00 +0000",
	"",
	"Hello",
].join("\r\n")).buffer;

/** A D1 stand-in whose writes to `contacts` fail, like a transient D1 error under import load. */
function failingContacts(database) {
	return new Proxy(database, {
		get(target, property) {
			if (property !== "prepare") return Reflect.get(target, property);
			return (sql) => {
				if (/^update "contacts"|^insert into "contacts"/i.test(sql)) {
					return { bind: () => ({ run: async () => { throw new Error("D1_ERROR: Network connection lost."); }, all: async () => { throw new Error("D1_ERROR: Network connection lost."); }, raw: async () => { throw new Error("D1_ERROR: Network connection lost."); } }) };
				}
				return target.prepare(sql);
			};
		},
	});
}

test("a failed contact update keeps the imported message", async (t) => {
	const database = new SqliteDatabase(join(outDir, "import.sqlite"));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = Math.floor(Date.now() / 1000);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(now);
	const stored = [];
	const env = { DB: failingContacts(database), BUCKET: { put: async (key) => stored.push(key), delete: async () => undefined } };
	const errors = [];
	const originalError = console.error;
	console.error = (...args) => errors.push(args.join(" "));
	t.after(() => { console.error = originalError; });

	const result = await importMessagesToMailbox(env, {
		userId: "u1",
		mailboxId: "mb1",
		destination: { type: "system", section: "sent" },
		messages: [{ filename: "takeout-1.eml", raw }],
	});

	assert.deepEqual(result, { imported: 1, skipped: 0, errors: [] });
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
	assert.equal(stored.length, 1);
	assert.match(errors.join("\n"), /Import contact update failed takeout-1\.eml D1_ERROR: Network connection lost/);
});

test("import errors show the driver's reason instead of the query and its values", () => {
	const wrapped = new Error('Failed query: update "contacts" set "display_name" = ? params: Iris', { cause: new Error("D1_ERROR: Network connection lost.") });
	assert.equal(describeImportError(wrapped), "D1_ERROR: Network connection lost.");
	assert.equal(describeImportError(new Error("Message is too large")), "Message is too large");
	assert.equal(describeImportError("nope"), "Import failed");
});
