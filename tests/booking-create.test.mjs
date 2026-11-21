import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-booking-create-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createBookedCalendarEvents } from "./src/lib/booking/create.ts";
		`,
		resolveDir: root,
		sourcefile: "booking-create-entry.ts",
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
const { SqliteDatabase, applyMigrations, createBookedCalendarEvents } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const START = "2030-01-07T10:00:00.000Z";
const END = "2030-01-07T11:00:00.000Z";
const bookingEvent = { hostIds: ["host"], name: "Intro", location: "", color: "#2563eb", timeZone: "UTC" };

async function fixture(t, responseStatus) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('host', 'host@example.com', 'hash', 'Host', 1)");
	database.db
		.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('busy', 'host', 'Busy', ?, ?, ?, 1, 1)")
		.run(Date.parse(START) / 1000, Date.parse(END) / 1000, responseStatus);
	return { DB: database };
}

test("an unanswered invitation does not block a booking, matching the slot list", async (t) => {
	const env = await fixture(t, "needs-action");
	assert.equal(await createBookedCalendarEvents(env, bookingEvent, "Guest", "guest@example.net", START, END), true);
});

test("an accepted or own event still blocks the slot", async (t) => {
	for (const status of [null, "accepted"]) {
		const env = await fixture(t, status);
		assert.equal(await createBookedCalendarEvents(env, bookingEvent, "Guest", "guest@example.net", START, END), false, String(status));
	}
});
