import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-send-rollback-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		send: join(root, "src/lib/email/send.ts"),
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
const send = await load("send");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const future = () => new Date(Date.now() + 3_600_000);

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, sending_provider, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 'cloudflare', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 'primary', ?)").run(now);
	const queued = [];
	const objects = new Map();
	let failQueue = false;
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value) => { objects.set(key, value); },
			get: async () => null,
			delete: async (keys) => { for (const key of [].concat(keys)) objects.delete(key); },
			head: async () => null,
		},
		EMAIL: { send: async () => ({ messageId: "<out@example.com>" }) },
		OUTBOUND_QUEUE: { send: async (message) => { if (failQueue) throw new Error("queue down"); queued.push(message); } },
	};
	const input = (overrides = {}) => ({ userId: "u1", mailboxId: "mb1", from: "kevin@example.com", to: "Anna <anna@example.org>", subject: "Hi", text: "hello", ...overrides });
	const count = (table) => database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
	return { env, queued, objects, input, count, raw: database.db, setFailQueue: (value) => { failQueue = value; } };
}

test("a failed queue send for a scheduled message leaves nothing behind", async (t) => {
	const { env, input, count, setFailQueue } = await createFixture(t);
	setFailQueue(true);
	await assert.rejects(send.sendEmail(env, input({ scheduledAt: future() })), /queue down/);
	assert.equal(count("messages"), 0);
	assert.equal(count("outbound_jobs"), 0);
	assert.equal(count("message_attachments"), 0);
});

test("a failed job insert leaves no queued message", async (t) => {
	const { env, input, count, raw } = await createFixture(t);
	raw.exec("CREATE TRIGGER no_jobs BEFORE INSERT ON outbound_jobs BEGIN SELECT RAISE(ABORT, 'job insert failed'); END");
	await assert.rejects(send.sendEmail(env, input({ scheduledAt: future() })), (error) => /job insert failed/.test(String(error.cause ?? error)));
	assert.equal(count("messages"), 0);
});

test("a successful scheduled send still stores the message and the job", async (t) => {
	const { env, queued, input, count } = await createFixture(t);
	const result = await send.sendEmail(env, input({ scheduledAt: future() }));
	assert.equal(result.scheduled, true);
	assert.equal(count("messages"), 1);
	assert.equal(count("outbound_jobs"), 1);
	assert.equal(queued.length, 1);
});

test("attachments stored for a failed send are removed", async (t) => {
	const { env, objects, input, count, setFailQueue } = await createFixture(t);
	setFailQueue(true);
	const attachments = [{ filename: "a.txt", type: "text/plain", content: new TextEncoder().encode("hi").buffer }];
	await assert.rejects(send.sendEmail(env, input({ scheduledAt: future(), attachments })), /queue down/);
	assert.equal(count("message_attachments"), 0);
	assert.equal(objects.size, 0);
});
