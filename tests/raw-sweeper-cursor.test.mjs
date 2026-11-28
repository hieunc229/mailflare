import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("raw-sweeper-cursor", `export { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper.ts";`);

const MARKER = "sweep-state/raw-mail-cursor";
const REFERENCED = 2100;
const key = (index) => `inbound/${String(index).padStart(7, "0")}-ref.eml`;
const ORPHAN = "inbound/9999999-orphan.eml";

async function setup(t, { rejectCursors = false } = {}) {
	const seed = `${sharedMailboxSeed("full_access")}
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${REFERENCED})
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, raw_r2_key, created_at)
		SELECT 'm-' || i, 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hi', 'received', 0,
			'inbound/' || substr('0000000' || i, -7, 7) || '-ref.eml', 1 FROM n;
	`;
	const fixture = await newDatabase(t, seed);
	const now = new Date("2026-11-25T12:00:00Z");
	const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
	const store = new Map();
	for (let index = 0; index < REFERENCED; index += 1) store.set(key(index), old);
	store.set(ORPHAN, old);
	const lists = [];
	fixture.env.BUCKET = {
		store,
		async list({ prefix, cursor, limit = 100 }) {
			lists.push(cursor);
			if (cursor && rejectCursors) throw new Error("bad cursor");
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
			const page = keys.slice(0, limit);
			return { objects: page.map((k) => ({ key: k, uploaded: store.get(k) })), truncated: keys.length > page.length, cursor: page.at(-1) };
		},
		async get(k) { const value = store.get(k); return typeof value === "string" ? { text: async () => value } : null; },
		async put(k, value) { store.set(k, String(value)); },
		async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
	};
	return { env: fixture.env, store, lists, now };
}

test("an orphan past the first 2,000 keys is deleted on the next run", async (t) => {
	const { env, store, now } = await setup(t);
	assert.equal(await app.sweepOrphanedRawMail(env, now), 0);
	assert.ok(store.has(ORPHAN));
	assert.ok(store.has(MARKER));
	assert.equal(await app.sweepOrphanedRawMail(env, now), 1);
	assert.ok(!store.has(ORPHAN));
});

test("a finished listing clears the marker and the next run starts at the oldest key", async (t) => {
	const { env, store, lists, now } = await setup(t);
	await app.sweepOrphanedRawMail(env, now);
	await app.sweepOrphanedRawMail(env, now);
	assert.ok(!store.has(MARKER));
	lists.length = 0;
	await app.sweepOrphanedRawMail(env, now);
	assert.equal(lists[0], undefined);
});

test("a rejected cursor is dropped without failing the run", async (t) => {
	const { env, store, now } = await setup(t, { rejectCursors: true });
	store.set(MARKER, key(500));
	await assert.doesNotReject(app.sweepOrphanedRawMail(env, now));
	assert.ok(!store.has(MARKER));
});

test("referenced keys are never deleted", async (t) => {
	const { env, store, now } = await setup(t);
	for (let run = 0; run < 3; run += 1) await app.sweepOrphanedRawMail(env, now);
	for (let index = 0; index < REFERENCED; index += 1) assert.ok(store.has(key(index)), key(index));
});
