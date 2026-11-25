import assert from "node:assert/strict";
import test from "node:test";
import { as, call, loadRoutes, request, seed } from "./promotions-route-harness.mjs";

const m = await loadRoutes("promotions-navigation", `
	export * as navigation from "./src/app/api/messages/navigation/route.ts";
	export * as list from "./src/app/api/messages/route.ts";
	export { categoryScopeCondition } from "./src/lib/promotions/settings.ts";
	export { getDb } from "./src/db/index.ts";
	export { messages } from "./src/db/schema/index.ts";
`);

const nav = (query) => call(m.navigation.GET, request(`/api/messages/navigation?${query}`));
const list = (query) => call(m.list.GET, request(`/api/messages?${query}`));
const ids = (result) => result.body.messages.map((row) => row.id);

/** Mailbox a is `separate`, b is `show`, c is off (no row), s (shared) is off with an explicit row. */
async function fixture(t) {
	const database = await seed(t, m);
	database.db.exec(`
		INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', 'separate', 1), ('s', 'off', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('b', 'u', 'd', 'b', 'personal', 1), ('c', 'u', 'd', 'c', 'personal', 1);
		INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('b', 'show', 1);
	`);
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, folder_id, snoozed_until, created_at) VALUES (?, 'u', ?, 'inbound', 'x@x.test', 'o@one.test', ?, ?, NULL, ?, ?)");
	let at = 100;
	const add = (id, mailbox, category, { status = "received", snoozed = null } = {}) => insert.run(id, mailbox, status, category, snoozed, at++);
	add("a-promo", "a", "promotions");
	add("a-plain", "a", null);
	add("a-primary", "a", "primary");
	add("b-promo", "b", "promotions");
	add("c-promo", "c", "promotions");
	add("s-promo", "s", "promotions");
	add("a-promo-trash", "a", "promotions", { status: "trash" });
	add("a-promo-snoozed", "a", "promotions", { snoozed: Math.floor(Date.now() / 1000) + 3600 });
	return database;
}

test("list category=promotions only reaches mailboxes whose mode is not off", async (t) => {
	await fixture(t);
	assert.deepEqual((await list("status=received&category=promotions")).body.messages.map((row) => row.id).sort(), ["a-promo", "b-promo"]);
	assert.deepEqual((await list("status=received&category=promotions&mailboxId=a")).body.messages.map((row) => row.id), ["a-promo"]);
	assert.deepEqual((await list("status=received&category=promotions&mailboxId=c")).body.messages, []);
});

test("navigation folder=promotions lists the same rows as the list, newest first, and nothing from off mailboxes", async (t) => {
	await fixture(t);
	const all = await nav("folder=promotions");
	assert.equal(all.status, 200);
	assert.deepEqual(ids(all), ["b-promo", "a-promo"]);
	const listed = await list("status=received&category=promotions");
	assert.deepEqual(ids(all), listed.body.messages.map((row) => row.id));
	assert.deepEqual(ids(await nav("folder=promotions&mailboxId=a")), ["a-promo"]);
	assert.deepEqual(ids(await nav("folder=promotions&mailboxId=c")), []);
	assert.deepEqual(ids(await nav("folder=promotions&mailboxId=s")), []);
});

test("navigation folder=promotions refuses a folderId, like the list", async (t) => {
	await fixture(t);
	assert.equal((await nav("folder=promotions&folderId=f")).status, 400);
});

test("navigation folder=inbox hides promotions of separate mailboxes only, matching the list", async (t) => {
	await fixture(t);
	const navigated = ids(await nav("folder=inbox"));
	assert.deepEqual([...navigated].sort(), ["a-plain", "a-primary", "b-promo", "c-promo", "s-promo"]);
	const listed = (await list("status=received&direction=inbound")).body.messages.map((row) => row.id);
	assert.deepEqual([...navigated].sort(), [...listed].sort());
	assert.deepEqual(ids(await nav("folder=inbox&mailboxId=a")).sort(), ["a-plain", "a-primary"]);
	assert.deepEqual(ids(await nav("folder=inbox&mailboxId=b")), ["b-promo"]);
});

test("other folders are unaffected by promotions modes", async (t) => {
	await fixture(t);
	assert.deepEqual(ids(await nav("folder=trash")), ["a-promo-trash"]);
});

test("a delegate with no mailbox access gets an empty promotions navigation", async (t) => {
	await fixture(t);
	as({ id: "r", role: "user", email: "r@one.test", timeZone: "UTC" });
	assert.deepEqual(ids(await nav("folder=promotions")), []);
});

test("categoryScopeCondition binds the shorter mailbox list, so 120 mailboxes stay under D1's 100 parameters", async (t) => {
	const database = await seed(t, m);
	const db = m.getDb(globalThis.__mailflareNodeEnv);
	const insert = database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES (?, 'u', 'd', ?, 'personal', 1)");
	const setting = database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES (?, ?, 1)");
	const scope = [];
	for (let i = 0; i < 120; i++) { insert.run(`m${i}`, `m${i}`); scope.push(`m${i}`); setting.run(`m${i}`, i < 60 ? "show" : i < 100 ? "separate" : "off"); }
	for (const kind of ["promotions", "inbox"]) {
		const condition = await m.categoryScopeCondition(db, scope, kind);
		assert.ok(condition, kind);
		const query = db.select({ id: m.messages.id }).from(m.messages).where(condition).toSQL();
		assert.ok(query.params.length < 100, `${kind}: ${query.params.length}`);
	}
});
