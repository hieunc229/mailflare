import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATE, as, call, loadRoutes, request, seed } from "./promotions-route-harness.mjs";

const m = await loadRoutes("promotions-move-api", `
	export * as category from "./src/app/api/messages/[messageId]/category/route.ts";
	export * as preference from "./src/app/api/subscriptions/preference/route.ts";
	export { MAX_REFILE_ROWS, REFILE_WINDOW_DAYS } from "./src/lib/promotions/refile-utils.ts";
`);
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const move = (messageId, body, options) => call(m.category.PATCH, request(`/api/messages/${messageId}/category`, { method: "PATCH", body, ...options }), { messageId });
const prefer = (body, options) => call(m.preference.PUT, request("/api/subscriptions/preference", { method: "PUT", body, ...options }));
const categories = (database, where = "1 = 1") => Object.fromEntries(database.db.prepare(`SELECT id, category FROM messages WHERE ${where}`).all().map((row) => [row.id, row.category]));
const count = (database, where) => database.db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get().n;

async function fixture(t, { mode = "show", ...options } = {}) {
	const database = await seed(t, m, options);
	if (mode) database.db.exec(`INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', '${mode}', 1), ('s', '${mode}', 1)`);
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, sender_address, created_at) VALUES (?, 'u', ?, ?, ?, 'o@one.test', ?, ?, ?, ?)");
	const add = (id, { mailbox = "a", direction = "inbound", sender = "news@acme.com", status = "received", category = null, age = 0 } = {}) =>
		insert.run(id, mailbox, direction, sender ?? "x@x.test", status, category, sender, now() - age * DAY - Number(id.replace(/\D/g, "")) % 1000);
	return { database, add };
}

/** Records the bound-parameter count of every statement a call runs. */
function trackParams(database) {
	const counts = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => { counts.push(values.length); return bind(...values); };
		return statement;
	};
	return counts;
}

test("an override re-files at most 500 of the newest rows, reports what is left, and stays under D1's 100 parameters", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 600; i++) add(`n${i}`, { age: 1 });
	const counts = trackParams(database);
	const result = await prefer({ mailboxId: "a", senderAddress: "News@Acme.com", category: "promotions" });
	assert.deepEqual(result, { status: 200, body: { category: "promotions", changed: 500, remainingOlder: 100 } });
	assert.equal(count(database, "category = 'promotions'"), 500);
	assert.equal(count(database, "category IS NULL"), 100);
	// Newest first: the untouched rows are the oldest ones (the helper offsets created_at by the numeric id).
	assert.equal(count(database, "category IS NULL AND created_at > (SELECT min(created_at) FROM messages WHERE category = 'promotions')"), 0);
	assert.ok(counts.length > 5 && Math.max(...counts) < 100, `max bound params ${Math.max(...counts)}`);
	assert.deepEqual(database.db.prepare("SELECT category_override FROM mailbox_sender_preferences WHERE mailbox_id = 'a' AND sender_address = 'news@acme.com'").all(), [{ category_override: "promotions" }]);
});

test("rows older than the window are left, counted as remaining, and a second call finishes nothing it cannot reach", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 10; i++) add(`n${i}`, { age: 5 });
	for (let i = 10; i < 15; i++) add(`n${i}`, { age: m.REFILE_WINDOW_DAYS + 1 });
	assert.deepEqual((await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" })).body, { category: "promotions", changed: 10, remainingOlder: 5 });
	assert.equal(count(database, "category = 'promotions' AND created_at < " + (now() - m.REFILE_WINDOW_DAYS * DAY)), 0);
	assert.deepEqual((await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" })).body, { category: "promotions", changed: 0, remainingOlder: 5 });
});

test("only that sender's received, unfiled inbound rows in that mailbox change", async (t) => {
	const { database, add } = await fixture(t);
	add("hit", {});
	add("other-sender", { sender: "other@acme.com" });
	add("other-mailbox", { mailbox: "s" });
	add("sent", { direction: "outbound", status: "sent" });
	add("trash", { status: "trash" });
	add("spam", { status: "spam" });
	add("null-sender", { sender: null });
	database.db.exec("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f', 'u', 'a', 'F', 1)");
	add("filed", {});
	database.db.exec("UPDATE messages SET folder_id = 'f' WHERE id = 'filed'");
	assert.equal((await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" })).body.changed, 1);
	assert.deepEqual(Object.entries(categories(database)).filter(([, category]) => category).map(([id]) => id), ["hit"]);
});

test("Inbox writes the primary marker, leaves rows that already carry it, and only touches promotions", async (t) => {
	const { database, add } = await fixture(t);
	add("p1", { category: "promotions" });
	add("p2", { category: "promotions" });
	add("marked", { category: "primary" });
	add("plain", {});
	assert.deepEqual((await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: "inbox" })).body, { category: "inbox", changed: 2, remainingOlder: 0 });
	assert.deepEqual(categories(database), { p1: "primary", p2: "primary", marked: "primary", plain: null });
	assert.equal(database.db.prepare("SELECT category_override FROM mailbox_sender_preferences").get().category_override, "inbox");
});

test("clearing the override leaves mail where it is", async (t) => {
	const { database, add } = await fixture(t);
	add("p1", { category: "promotions" });
	await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" });
	assert.deepEqual((await prefer({ mailboxId: "a", senderAddress: "news@acme.com", category: null })).body, { category: null, changed: 0, remainingOlder: 0 });
	assert.equal(database.db.prepare("SELECT category_override FROM mailbox_sender_preferences").get().category_override, null);
	assert.deepEqual(categories(database), { p1: "promotions" });
});

test("preference validates input, origin, session, mailbox access and mode", async (t) => {
	const { database } = await fixture(t);
	const ok = { mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" };
	for (const body of [null, { ...ok, category: "social" }, { ...ok, category: undefined }, { ...ok, senderAddress: "" }, { ...ok, senderAddress: "x".repeat(200) }, { ...ok, mailboxId: 4 }]) {
		assert.equal((await prefer(body)).status, 400, JSON.stringify(body));
	}
	assert.equal((await prefer(ok, { origin: false })).status, 403);
	assert.equal((await prefer({ ...ok, mailboxId: "nope" })).status, 404);
	as(DELEGATE);
	assert.equal((await prefer({ ...ok, mailboxId: "s" })).status, 403);
	assert.equal((await prefer({ ...ok, mailboxId: "a" })).status, 404);
	assert.equal(count(database, "1 = 1"), 0);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM mailbox_sender_preferences").get().n, 0);
	globalThis.__testUser = null;
	assert.equal((await prefer(ok)).status, 401);
});

test("preference answers 409 PROMOTIONS_OFF when the mailbox mode is off, and MIGRATION_REQUIRED without the tables", async (t) => {
	const { database } = await fixture(t, { mode: null });
	const ok = { mailboxId: "a", senderAddress: "news@acme.com", category: "promotions" };
	assert.equal((await prefer(ok)).body.code, "PROMOTIONS_OFF");
	database.db.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', 'off', 1)");
	assert.deepEqual([(await prefer(ok)).status, (await prefer(ok)).body.code], [409, "PROMOTIONS_OFF"]);
	database.db.exec("UPDATE mailbox_promotion_settings SET mode = 'show'; DROP TABLE mailbox_sender_preferences");
	const missing = await prefer(ok);
	assert.deepEqual([missing.status, missing.body.code], [409, "MIGRATION_REQUIRED"]);
});

test("moving one message to Promotions and back to Inbox", async (t) => {
	const { database, add } = await fixture(t);
	add("one", {});
	add("two", {});
	assert.deepEqual((await move("one", { category: "promotions" })), { status: 200, body: { category: "promotions", changed: 1, remainingOlder: 0 } });
	assert.deepEqual(categories(database), { one: "promotions", two: null });
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM mailbox_sender_preferences").get().n, 0);
	assert.equal((await move("one", { category: "inbox" })).body.changed, 1);
	assert.deepEqual(categories(database), { one: "primary", two: null });
});

test("applyToSender stores the override and re-files the sender's other rows within the bound", async (t) => {
	const { database, add } = await fixture(t);
	add("one", {});
	for (let i = 2; i < 8; i++) add(`n${i}`, {});
	add("old", { age: m.REFILE_WINDOW_DAYS + 5 });
	const result = await move("one", { category: "promotions", applyToSender: true });
	assert.deepEqual(result, { status: 200, body: { category: "promotions", changed: 7, remainingOlder: 1 } });
	assert.equal(database.db.prepare("SELECT category_override FROM mailbox_sender_preferences WHERE sender_address = 'news@acme.com'").get().category_override, "promotions");
	assert.equal(categories(database).old, null);
});

test("applyToSender needs a sender address on the message", async (t) => {
	const { database, add } = await fixture(t);
	add("bare", { sender: null });
	assert.equal((await move("bare", { category: "promotions", applyToSender: true })).status, 400);
	assert.equal(categories(database).bare, null);
	assert.equal((await move("bare", { category: "promotions" })).status, 200);
});

test("move validates input, origin, session, ownership, direction and mode", async (t) => {
	const { database, add } = await fixture(t);
	add("one", {});
	add("sent", { direction: "outbound", status: "sent" });
	add("shared", { mailbox: "s" });
	for (const body of [null, {}, { category: "primary" }, { category: "promotions", applyToSender: "yes" }]) assert.equal((await move("one", body)).status, 400, JSON.stringify(body));
	assert.equal((await move("one", { category: "promotions" }, { origin: false })).status, 403);
	assert.equal((await move("nope", { category: "promotions" })).status, 404);
	assert.equal((await move("sent", { category: "promotions" })).status, 400);
	as(DELEGATE);
	assert.equal((await move("shared", { category: "promotions" })).status, 403);
	assert.equal((await move("one", { category: "promotions" })).status, 404);
	assert.equal(categories(database).shared, null);
	as({ id: "u", role: "admin", email: "o@one.test", timeZone: "UTC" });
	database.db.exec("UPDATE mailbox_promotion_settings SET mode = 'off' WHERE mailbox_id = 'a'");
	const off = await move("one", { category: "promotions" });
	assert.deepEqual([off.status, off.body.code], [409, "PROMOTIONS_OFF"]);
	assert.equal(categories(database).one, null);
	globalThis.__testUser = null;
	assert.equal((await move("one", { category: "promotions" })).status, 401);
});

test("a delegate with full access may move mail", async (t) => {
	const { database, add } = await fixture(t, { delegatePermission: "full_access" });
	add("shared", { mailbox: "s" });
	as(DELEGATE);
	assert.equal((await move("shared", { category: "promotions" })).status, 200);
	assert.equal(categories(database).shared, "promotions");
});
