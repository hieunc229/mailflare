import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Under tests/ so the external packages in node_modules resolve from the bundle.
const outDir = mkdtempSync(join(root, "tests", ".tmp-jmap-eventsource-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * The EventSource handler is only reachable through `handleJmapRequest`, so the test calls the real
 * entry point with a real API key over a real database. Timers are mocked, so a tick costs nothing.
 */
await build({
	stdin: {
		contents: `
			export { handleJmapRequest } from "./src/lib/jmap/handler.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-eventsource-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { handleJmapRequest, clearApiKeyVerificationCache, generateApiKey, SqliteDatabase, applyMigrations } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

/** The shortest interval the eventsource route accepts (see parsePingSeconds). */
const PING_MS = 10_000;

async function createFixture(t) {
	clearApiKeyVerificationCache();
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => {
		database.db.close();
		clearApiKeyVerificationCache();
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', 'admin', 0)").run();
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 0)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', 0)").run();
	const key = await generateApiKey();
	database.db
		.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'test key', ?, ?, ?, 'legacy', '[\"jmap\"]', 0)")
		.run(key.prefix, key.hash, key.sha256);
	return { database, env: { DB: database }, key: key.fullKey };
}

async function openEventStream(env, key) {
	const response = await handleJmapRequest(new Request("https://mail.example/jmap/eventsource?ping=10", { headers: { Authorization: `Bearer ${key}` } }), env);
	assert.equal(response?.status, 200);
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	return response.body.getReader();
}

/** One enqueue carries exactly one event, terminated by a blank line. */
async function readEvent(reader) {
	const { value, done } = await reader.read();
	assert.equal(done, false, "the stream closed unexpectedly");
	const [eventLine, dataLine] = new TextDecoder().decode(value).trimEnd().split("\n");
	return { event: eventLine.replace(/^event: /, ""), data: JSON.parse(dataLine.replace(/^data: /, "")) };
}

test("a message arriving after the first tick still moves the EventSource state", async (t) => {
	const { database, env, key } = await createFixture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const reader = await openEventStream(env, key);

	const initial = await readEvent(reader);
	assert.equal(initial.event, "state");
	const initialState = initial.data.changed.u1.Email;
	assert.match(initialState, /^c1:\d+:/);

	// Nothing changed, so the tick is a plain ping.
	t.mock.timers.tick(PING_MS);
	const unchanged = await readEvent(reader);
	assert.equal(unchanged.event, "ping");
	assert.equal(unchanged.data.interval, 10);

	// The same insert the inbound pipeline makes: the trigger logs it, so the state moves.
	database.db
		.prepare(
			"INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'sam@example.net', 'kevin@example.com', 'Hello', 'received', 't1', 1)",
		)
		.run();

	t.mock.timers.tick(PING_MS);
	const changed = await readEvent(reader);
	assert.equal(changed.event, "state");
	assert.notEqual(changed.data.changed.u1.Email, initialState);
	assert.equal(changed.data.changed.u1.Thread, changed.data.changed.u1.Email);
	assert.equal(changed.data["@type"], "StateChange");

	await reader.cancel();
});

test("a cancelled stream stops polling the state", async (t) => {
	const { database, env, key } = await createFixture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const reader = await openEventStream(env, key);
	assert.equal((await readEvent(reader)).event, "state");

	// Any further tick would read the change log through the D1-shaped API, so count prepares.
	let prepares = 0;
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		prepares += 1;
		return prepare(sql);
	};

	await reader.cancel();
	t.mock.timers.tick(PING_MS * 3);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(prepares, 0, "a cancelled stream must not query the state again");
});
