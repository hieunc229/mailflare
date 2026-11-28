import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("contacts-seen-scan", `export { addressesSeenInMailbox } from "./src/app/api/contacts/utils.ts";`);

async function fixture(t, count, extra = "") {
	const f = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < ${count})
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at)
		SELECT printf('m%04d', n), 'admin', 'mb-team', 'inbound', 'nobody@z.test', 'nobody@z.test', 's', 'inbox', 1 FROM c;
		${extra}`);
	const sqls = [];
	const prepare = f.env.DB.prepare.bind(f.env.DB);
	f.env.DB.prepare = (sql) => { if (/from "messages"/i.test(sql)) sqls.push(sql); return prepare(sql); };
	return { ...f, sqls };
}

test("finds an address that only appears after 500 other matches", async (t) => {
	const { db } = await fixture(t, 600, `UPDATE messages SET to_addr = 'bulk@x.test'; UPDATE messages SET cc_addr = 'late@x.test' WHERE id = 'm0600';`);
	assert.deepEqual([...await app.addressesSeenInMailbox(db, "mb-team", ["bulk@x.test", "late@x.test"], "delegate")].sort(), ["bulk@x.test", "late@x.test"]);
});

test("150 addresses are answered in at most 2 queries over 1200 messages", async (t) => {
	const { db, sqls } = await fixture(t, 1200, `UPDATE messages SET to_addr = 'person7@x.test' WHERE id = 'm0900';`);
	const emails = Array.from({ length: 150 }, (_, i) => `person${i}@x.test`);
	assert.deepEqual([...await app.addressesSeenInMailbox(db, "mb-team", emails, "delegate")], ["person7@x.test"]);
	assert.ok(sqls.length <= 2, `queries: ${sqls.length}`);
});

test("a single address stops at the first page that has it", async (t) => {
	const { db, sqls } = await fixture(t, 1200, `UPDATE messages SET to_addr = 'one@x.test' WHERE id = 'm0001';`);
	assert.deepEqual([...await app.addressesSeenInMailbox(db, "mb-team", ["one@x.test"], "delegate")], ["one@x.test"]);
	assert.equal(sqls.length, 1);
});

test("a single address query is narrowed with LIKE, a long list is not", async (t) => {
	const { db, sqls } = await fixture(t, 5);
	await app.addressesSeenInMailbox(db, "mb-team", ["one@x.test"], "delegate");
	assert.match(sqls[0], /like/i);
	sqls.length = 0;
	await app.addressesSeenInMailbox(db, "mb-team", Array.from({ length: 60 }, (_, i) => `p${i}@x.test`), "delegate");
	assert.ok(sqls.length >= 1);
	assert.doesNotMatch(sqls[0], /like/i);
});

test("an empty list runs no query", async (t) => {
	const { db, sqls } = await fixture(t, 5);
	assert.equal((await app.addressesSeenInMailbox(db, "mb-team", [], "delegate")).size, 0);
	assert.equal(sqls.length, 0);
});

test("a long list reads at most 5 pages however large the mailbox is", async (t) => {
	const { db, sqls } = await fixture(t, 7000, `UPDATE messages SET to_addr = 'deep@x.test' WHERE id = 'm6500';`);
	const emails = ["deep@x.test", ...Array.from({ length: 59 }, (_, i) => `p${i}@x.test`)];
	assert.deepEqual([...await app.addressesSeenInMailbox(db, "mb-team", emails, "delegate")], []);
	assert.equal(sqls.length, 5);
});
