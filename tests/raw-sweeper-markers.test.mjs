import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("raw-sweeper-markers", `export { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper.ts";`);

function bucket(objects) {
	const store = new Map(objects);
	return {
		store,
		async list({ prefix, cursor, limit = 100 }) {
			const keys = [...store.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
			const page = keys.slice(0, limit);
			return { objects: page.map((key) => ({ key, uploaded: store.get(key) })), truncated: keys.length > page.length, cursor: page.at(-1) };
		},
		async delete(keys) { for (const key of [].concat(keys)) store.delete(key); },
	};
}

test("the daily sweep removes old Resend replay markers and keeps those inside the retry window", async (t) => {
	const { env } = await newDatabase(t);
	const now = new Date("2026-11-25T12:00:00Z");
	const day = 24 * 60 * 60 * 1000;
	const files = bucket([
		["provider-events/resend/msg_old", new Date(now.getTime() - 4 * day)],
		["provider-events/resend/msg_retry_window", new Date(now.getTime() - 2 * day)],
		["provider-events/resend/msg_new", new Date(now.getTime() - 60_000)],
	]);
	await app.sweepOrphanedRawMail({ ...env, BUCKET: files }, now);
	assert.deepEqual([...files.store.keys()].sort(), ["provider-events/resend/msg_retry_window", "provider-events/resend/msg_new"].sort());
});
