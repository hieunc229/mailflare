import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-calendar-confirm-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/calendar/confirmation.ts")], outfile: join(dir, "c.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@": join(root, "src") } });
const { createCalendarConfirmation, readCalendarConfirmation } = await import(pathToFileURL(join(dir, "c.mjs")).href);

const env = { CF_TOKEN: "test-secret" };
const input = { eventIds: ["evt_1", "evt_2"] };

test("a confirmation token binds user, action, input and lifetime", async () => {
	const now = 1_900_000_000_000;
	const token = await createCalendarConfirmation(env, "usr_1", "delete_events", input, now);
	const read = await readCalendarConfirmation(env, token, "usr_1", now + 1000);
	assert.deepEqual({ name: read.name, input: read.input }, { name: "delete_events", input });
	assert.equal(await readCalendarConfirmation(env, token, "usr_2", now + 1000), null, "other user");
	assert.equal(await readCalendarConfirmation(env, token, "usr_1", now + 16 * 60_000), null, "expired");
	assert.equal(await readCalendarConfirmation({ CF_TOKEN: "other" }, token, "usr_1", now + 1000), null, "other installation");
	const [payload, signature] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ userId: "usr_1", name: "delete_events", input: { eventIds: ["evt_9"] }, expiresAt: now + 60_000 })).toString("base64url");
	assert.equal(await readCalendarConfirmation(env, `${forged}.${signature}`, "usr_1", now + 1000), null, "tampered input");
	assert.ok(payload);
});

test("a read-only tool cannot be confirmed into existence", async () => {
	const token = await createCalendarConfirmation(env, "usr_1", "get_schedule", {}, Date.now());
	assert.equal(await readCalendarConfirmation(env, token, "usr_1"), null);
});
