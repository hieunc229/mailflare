import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("unsubscribe-store", `
	export { fromStoredUnsubscribe, toStoredUnsubscribe, extractUnsubscribeUrlFromRaw } from "./src/lib/email/unsubscribe.ts";
	export { resolveUnsubscribe, recordUnsubscribe } from "./src/lib/email/unsubscribe-store.ts";
	export { getMessageWithBodyForUser, getMessageMetadataForUser } from "./src/lib/email/inbound.ts";
`);

const enc = (s) => new TextEncoder().encode(s).buffer;
const rawWith = (headers) => enc(`From: list@x.com\r\n${headers}\r\n\r\nbody`);
const DKIM = "DKIM-Signature: v=1; a=rsa-sha256; d=x.com; s=s; h=from:to:list-unsubscribe:list-unsubscribe-post; b=abc\r\n";
const ONE_CLICK = "List-Unsubscribe: <mailto:un@x.com>, <https://x.com/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n";

test("stored form round-trips url+mailto, one-click, none and unsigned headers", () => {
	const cases = [
		rawWith("List-Unsubscribe: <mailto:un@x.com>, <https://x.com/u/1>\r\n"),
		rawWith(ONE_CLICK + DKIM),
		rawWith(ONE_CLICK + "DKIM-Signature: v=1; d=x.com; h=from:to; b=abc\r\n"),
		rawWith("Subject: hi\r\n"),
	];
	for (const raw of cases) {
		const candidate = app.extractUnsubscribeUrlFromRaw(raw);
		assert.deepEqual(app.fromStoredUnsubscribe(app.toStoredUnsubscribe(candidate)), candidate);
	}
	assert.deepEqual(app.toStoredUnsubscribe(null), { url: null, oneClick: false, mailto: null, dkimCovers: false });
	const unsigned = app.extractUnsubscribeUrlFromRaw(cases[2]);
	assert.equal(unsigned.oneClick, true);
	assert.equal(unsigned.dkimCoversUnsubscribe, false, "DKIM not covering List-Unsubscribe stays recorded as false");
	assert.deepEqual(app.toStoredUnsubscribe(app.extractUnsubscribeUrlFromRaw(cases[0])), { url: "https://x.com/u/1", oneClick: false, mailto: "mailto:un@x.com", dkimCovers: false });
});

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'u@x.test', 'h', 'U', 'admin', 1, 1);
	INSERT INTO messages (id, user_id, direction, from_addr, to_addr, status, raw_r2_key, created_at) VALUES
		('m1', 'u', 'inbound', 'a@x.com', 'b@x.test', 'received', 'raw/1', 1),
		('m2', 'u', 'inbound', 'a@x.com', 'b@x.test', 'received', 'raw/2', 2),
		('m3', 'u', 'inbound', 'a@x.com', 'b@x.test', 'received', 'raw/missing', 3),
		('m4', 'u', 'outbound', 'b@x.test', 'a@x.com', 'sent', NULL, 4);
`;

function bucket(objects) {
	const reads = [];
	return { reads, get: async (key) => { reads.push(key); return objects[key] ? { arrayBuffer: async () => objects[key] } : null; } };
}

test("a row that predates the table is read from R2 once, then served from the table", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	env.BUCKET = bucket({ "raw/1": rawWith(ONE_CLICK + DKIM), "raw/2": rawWith("Subject: plain\r\n") });
	const first = await app.resolveUnsubscribe(env, "m1", "raw/1");
	assert.equal(first.url, "https://x.com/u/1");
	assert.equal(first.oneClick && first.dkimCoversUnsubscribe, true);
	assert.deepEqual(env.BUCKET.reads, ["raw/1"]);
	assert.deepEqual(await app.resolveUnsubscribe(env, "m1", "raw/1"), first);
	assert.deepEqual(env.BUCKET.reads, ["raw/1"], "second open does not touch R2");
	// "computed: none" is remembered too.
	assert.equal(await app.resolveUnsubscribe(env, "m2", "raw/2"), null);
	assert.equal(await app.resolveUnsubscribe(env, "m2", "raw/2"), null);
	assert.deepEqual(env.BUCKET.reads, ["raw/1", "raw/2"]);
	assert.equal(sqlite.prepare("SELECT url FROM message_unsubscribe WHERE message_id = 'm2'").get().url, null);
});

test("a missing raw object or key is not remembered as 'none'", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	env.BUCKET = bucket({});
	assert.equal(await app.resolveUnsubscribe(env, "m3", "raw/missing"), null);
	assert.equal(await app.resolveUnsubscribe(env, "m4", null), null);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM message_unsubscribe").get().n, 0);
	assert.deepEqual(env.BUCKET.reads, ["raw/missing"], "no key, no read");
});

test("the write-back never fails the open and does not touch the messages row or JMAP log", async (t) => {
	const { env, sqlite } = await newDatabase(t, seed);
	env.BUCKET = bucket({ "raw/1": rawWith(ONE_CLICK + DKIM) });
	const before = sqlite.prepare("SELECT count(*) AS n FROM jmap_changes").get().n;
	sqlite.exec("DROP TABLE message_unsubscribe");
	assert.equal((await app.resolveUnsubscribe(env, "m1", "raw/1")).url, "https://x.com/u/1", "table missing (deploy before migrate): still answers from R2");
	sqlite.exec("CREATE TABLE message_unsubscribe (message_id text PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE cascade, url text, one_click integer NOT NULL DEFAULT 0, mailto text, dkim_covers integer NOT NULL DEFAULT 0, checked_at integer NOT NULL)");
	await app.resolveUnsubscribe(env, "m1", "raw/1");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM jmap_changes").get().n, before);
	sqlite.exec("DELETE FROM messages WHERE id = 'm1'");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM message_unsubscribe").get().n, 0, "removed with the message");
});

test("stored values are served without an R2 read", async (t) => {
	const { env } = await newDatabase(t, seed);
	env.BUCKET = bucket({});
	await app.recordUnsubscribe(env, "m1", app.extractUnsubscribeUrlFromRaw(rawWith(ONE_CLICK + DKIM)));
	const got = await app.resolveUnsubscribe(env, "m1", "raw/1");
	assert.equal(got.mailto, "mailto:un@x.com");
	assert.deepEqual(env.BUCKET.reads, []);
});
