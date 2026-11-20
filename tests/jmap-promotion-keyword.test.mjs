import assert from "node:assert/strict";
import test from "node:test";
import { loadRoutes, seed } from "./promotions-route-harness.mjs";

const m = await loadRoutes("jmap-promotion-keyword", `
	export { KEYWORD_PROMOTION, KEYWORD_SEEN } from "./src/lib/jmap/constants.ts";
	export { keywordsFor, mailboxIdsFor } from "./src/lib/jmap/email-objects.ts";
	export { keywordCondition } from "./src/lib/jmap/email-query.ts";
	export { keywordsFromPatch } from "./src/lib/jmap/emails.ts";
	export { getDb } from "./src/db/index.ts";
	export { messages } from "./src/db/schema/index.ts";
`);

const row = (overrides = {}) => ({ id: "m", mailboxId: "a", folderId: null, status: "received", direction: "inbound", read: false, starred: false, category: null, ...overrides });

test("the keyword is $promotion", () => assert.equal(m.KEYWORD_PROMOTION, "$promotion"));

const on = new Map([["a", "show"]]);

test("keywordsFor sets $promotion for promotions only; primary and unclassified rows do not carry it", () => {
	assert.equal(m.keywordsFor(row({ category: "promotions" }), on)[m.KEYWORD_PROMOTION], true);
	assert.deepEqual(m.keywordsFor(row({ category: "primary" }), on), {});
	assert.deepEqual(m.keywordsFor(row(), on), {});
	assert.deepEqual(m.keywordsFor(row({ category: "promotions", read: true, starred: true }), new Map([["a", "separate"]])), { $seen: true, $flagged: true, $promotion: true });
});

test("a mailbox whose mode is off, has no settings row, or is unknown to the caller gets exactly the keywords it had before", () => {
	const promo = row({ category: "promotions", read: true });
	for (const modes of [new Map([["a", "off"]]), new Map(), new Map([["other", "show"]]), undefined]) assert.deepEqual(m.keywordsFor(promo, modes), { $seen: true });
});

test("a promotion stays in the JMAP Inbox in every mode", () => {
	const ids = Object.keys(m.mailboxIdsFor(row({ category: "promotions" })));
	assert.deepEqual(ids, Object.keys(m.mailboxIdsFor(row())));
	assert.equal(ids.length, 1);
});

test("keywordCondition: present is category = promotions, absent is null or anything else, so primary counts as absent", async (t) => {
	const database = await seed(t, m);
	database.db.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', 'show', 1)");
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, created_at) VALUES (?, 'u', 'a', 'inbound', 'x@x.test', 'o@one.test', 'received', ?, 1)");
	insert.run("promo", "promotions");
	insert.run("primary", "primary");
	insert.run("plain", null);
	const db = m.getDb(globalThis.__mailflareNodeEnv);
	const ids = async (present) => (await db.select({ id: m.messages.id }).from(m.messages).where(m.keywordCondition(m.KEYWORD_PROMOTION, present))).map((r) => r.id).sort();
	assert.deepEqual(await ids(true), ["promo"]);
	assert.deepEqual(await ids(false), ["plain", "primary"]);
});

test("keywordCondition ignores promotions of a mailbox that is off: hasKeyword matches nothing there and notKeyword matches everything, as before", async (t) => {
	const database = await seed(t, m);
	database.db.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', 'off', 1), ('s', 'separate', 1)");
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, created_at) VALUES (?, 'u', ?, 'inbound', 'x@x.test', 'o@one.test', 'received', 'promotions', 1)");
	insert.run("off-promo", "a");
	insert.run("on-promo", "s");
	const db = m.getDb(globalThis.__mailflareNodeEnv);
	const ids = async (present) => (await db.select({ id: m.messages.id }).from(m.messages).where(m.keywordCondition(m.KEYWORD_PROMOTION, present))).map((r) => r.id).sort();
	assert.deepEqual(await ids(true), ["on-promo"]);
	assert.deepEqual(await ids(false), ["off-promo"]);
});

test("Email/set cannot write the keyword: patches naming $promotion change nothing", () => {
	assert.deepEqual(m.keywordsFromPatch({ "keywords/$promotion": true }), {});
	assert.deepEqual(m.keywordsFromPatch({ "keywords/$promotion": false, "keywords/$seen": true }), { read: true });
	const whole = m.keywordsFromPatch({ keywords: { $promotion: true, $seen: true } });
	assert.deepEqual(whole, { read: true, starred: false });
});
