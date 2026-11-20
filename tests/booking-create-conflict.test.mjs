import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-booking-create-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { create: join(root, "src/lib/booking/create.ts") }, outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") }, external: ["better-sqlite3", "pg", "postgres", "mysql2", "@neondatabase/serverless", "@planetscale/database", "@libsql/client", "@electric-sql/pglite", "bun:sqlite", "cloudflare:workers"],
	plugins: [{ name: "db", setup(b) {
		b.onResolve({ filter: /^@\/db$/ }, () => ({ path: "db", namespace: "mock" }));
		b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ loader: "js", contents: `export function getDb() { return globalThis.__db; }` }));
	} }],
});
const { createBookedCalendarEvents } = await import(pathToFileURL(join(dir, "create.mjs")).href);

const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));
const sqlite = new Database(":memory:");
for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
const orm = drizzle(sqlite);
// The booking code reads a D1-style result; better-sqlite3 reports the same number as `changes`.
globalThis.__db = { run: async (query) => ({ meta: { changes: orm.run(query).changes } }) };
sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('h1', 'h1@one.test', 'H', 'x', 'user', 1)").run();

const bookable = { name: "Intro", hostIds: ["h1"], location: "", color: "blue", timeZone: "UTC" };
const START = "2030-05-06T09:00:00.000Z";
const END = "2030-05-06T09:30:00.000Z";
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
let n = 0;
function busy(status) {
	sqlite.exec("DELETE FROM calendar_events");
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, response_status) VALUES (?, 'h1', 'Busy', ?, ?, 1, 1, ?)").run(`busy_${n++}`, at("2030-05-06T08:45:00Z"), at("2030-05-06T09:15:00Z"), status);
}
const book = () => createBookedCalendarEvents({}, bookable, "Guest", "g@x.test", START, END);

test("a slot is taken by an accepted, tentative or self-made overlapping event", async () => {
	for (const status of [null, "accepted", "tentative"]) { busy(status); assert.equal(await book(), false, String(status)); }
});

test("declined, cancelled and not-yet-answered events do not block a slot, as in the availability list", async () => {
	for (const status of ["declined", "cancelled", "needs-action"]) { busy(status); assert.equal(await book(), true, status); }
});
