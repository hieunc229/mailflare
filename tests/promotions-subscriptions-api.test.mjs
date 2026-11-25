import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DELEGATE, OWNER, as, call, loadRoutes, request, seed } from "./promotions-route-harness.mjs";

const m = await loadRoutes("promotions-subscriptions-api", `
	export * as list from "./src/app/api/subscriptions/route.ts";
	export * as trash from "./src/app/api/subscriptions/trash/route.ts";
	export * as unsubscribe from "./src/app/api/messages/[messageId]/unsubscribe/route.ts";
	export { MAX_SWEEP_ROWS, SWEEP_WINDOW_DAYS } from "./src/lib/promotions/subscriptions-utils.ts";
`, {
	"@/lib/security/public-url": "export const isPublicHttpsUrl = () => true; export async function assertResolvesPublic() {}",
	"@/lib/email/outbound-provider": "export async function getOutboundProviderConfig() { return {}; } export async function sendThroughProvider() { if (globalThis.__mailFails) throw new Error('smtp down'); globalThis.__sent = (globalThis.__sent ?? 0) + 1; }",
});
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const list = (query = "") => call(m.list.GET, request(`/api/subscriptions${query}`));
const trash = (body, options) => call(m.trash.POST, request("/api/subscriptions/trash", { method: "POST", body, ...options }));
const unsubscribe = (messageId, body = {}) => call(m.unsubscribe.POST, request(`/api/messages/${messageId}/unsubscribe`, { method: "POST", body }), { messageId });
const count = (database, where) => database.db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get().n;

async function fixture(t, { mode = "show", ...options } = {}) {
	const database = await seed(t, m, options);
	if (mode) database.db.exec(`INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', '${mode}', 1), ('s', '${mode}', 1)`);
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, sender_address, read, has_unsubscribe, starred, created_at) VALUES (?, 'u', ?, ?, ?, 'o@one.test', ?, ?, ?, ?, ?, ?, ?)");
	let serial = 0;
	const add = (id, { mailbox = "a", direction = "inbound", sender = "news@acme.com", from, status = "received", category = "promotions", read = 0, unsub = 1, starred = 0, age = 0, at } = {}) =>
		insert.run(id, mailbox, direction, from ?? (sender ? `Acme News <${sender}>` : "x@x.test"), status, category, sender, read, unsub, starred, at ?? now() - age * DAY - serial++);
	return { database, add };
}

test("blockContact files a Trash rule, so the Subscriptions Block button means Trash and not rejection", () => {
	assert.match(readFileSync(new URL("../src/lib/contacts/service.ts", import.meta.url), "utf8"), /matchOperator: "exact" as const,[\s\S]*?action: "trash" as const[\s\S]*?priority: 100/);
});

test("senderSweepCondition matches the exact sender only", async (t) => {
	const { database, add } = await fixture(t);
	add("exact", { category: null });
	add("other", { sender: "othernews@acme.com", from: "othernews@acme.com", category: null });
	add("legacy-angle", { sender: null, from: "Acme <news@acme.com>", category: null });
	add("legacy-bare", { sender: null, from: "NEWS@acme.com", category: null });
	add("legacy-other", { sender: null, from: "othernews@acme.com", category: null });
	const result = await trash({ mailboxId: "a", senderAddress: "news@acme.com", previewOnly: true });
	assert.equal(result.body.count, 3);
	assert.equal(count(database, "status = 'received'"), 5);
});

test("GET with no mailbox, an unreadable mailbox or mode off answers an empty list, never an error", async (t) => {
	const { add } = await fixture(t, { mode: null });
	add("one");
	assert.deepEqual(await list(), { status: 200, body: { senders: [], total: 0 } });
	assert.deepEqual(await list("?mailboxId=nope"), { status: 200, body: { senders: [], total: 0 } });
	assert.deepEqual(await list("?mailboxId=a"), { status: 200, body: { senders: [], total: 0, mode: "off" } });
});

test("GET groups promotions of the last 90 days by sender, ranks by volume, excludes trash and spam, and reports read rate", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 4; i++) add(`big${i}`, { read: i < 1 ? 1 : 0, age: 1 + i });
	add("big-trash", { status: "trash" });
	add("big-spam", { status: "spam" });
	add("big-old", { age: 91 });
	add("big-primary", { category: "primary" });
	add("big-null", { category: null });
	add("big-outbound", { direction: "outbound", status: "sent" });
	for (let i = 0; i < 2; i++) add(`small${i}`, { sender: "deals@shop.com", read: 1, age: 2 + i, unsub: i === 0 ? 0 : 1 });
	add("other-mailbox", { mailbox: "s", sender: "elsewhere@x.com" });
	add("no-sender", { sender: null });
	const { status, body } = await list("?mailboxId=a");
	assert.equal(status, 200);
	assert.equal(body.total, 2);
	assert.deepEqual(body.senders.map((row) => [row.senderAddress, row.total]), [["news@acme.com", 4], ["deals@shop.com", 2]]);
	const [big, small] = body.senders;
	assert.equal(big.displayName, "Acme News");
	assert.equal(big.readCount, 1);
	assert.equal(big.readRate, 25);
	assert.equal(small.readRate, 100);
	// the newest non-spam non-trash message of the sender, whatever its category
	assert.equal(big.latestMessageId, "big-primary");
	assert.equal(big.canUnsubscribe, true);
	assert.equal(big.categoryOverride, null);
	assert.equal(big.unsubscribedAt, null);
	assert.equal(big.stillSending, false);
	assert.equal(typeof big.lastReceived, "string");
	assert.equal(count(database, "1=1") > 10, true);
});

test("senders tied on volume and recency are ordered by address, so pages never repeat or skip a sender", async (t) => {
	const { add } = await fixture(t);
	const same = now() - DAY;
	for (const sender of ["d@x.test", "b@x.test", "e@x.test", "a@x.test", "c@x.test"]) add(`m-${sender}`, { sender, at: same });
	const all = (await list("?mailboxId=a")).body.senders.map((row) => row.senderAddress);
	assert.deepEqual(all, ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"]);
});

test("latestMessageId skips spam and trash even when they are the newest message of the sender", async (t) => {
	const { add } = await fixture(t);
	add("good", { age: 5 });
	add("newer-trash", { status: "trash", age: 1 });
	add("newest-spam", { status: "spam", age: 0 });
	add("newest-outbound", { direction: "outbound", status: "sent", age: 0 });
	const { body } = await list("?mailboxId=a");
	assert.equal(body.senders[0].latestMessageId, "good");
	assert.equal(body.senders[0].total, 1);
});

test("GET pages 50 senders at a time, the batch stays at 50 statements with three binds each (mailbox, sender, limit), and total counts distinct senders", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 120; i++) add(`m${i}`, { sender: `s${String(i).padStart(3, "0")}@x.com`, age: 1 });
	const sizes = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => { sizes.push([sql, values.length]); return bind(...values); };
		return statement;
	};
	const first = await list("?mailboxId=a&limit=500");
	assert.equal(first.body.senders.length, 50);
	assert.equal(first.body.total, 120);
	const second = await list("?mailboxId=a&offset=100");
	assert.equal(second.body.senders.length, 20);
	assert.equal(new Set([...first.body.senders, ...second.body.senders].map((row) => row.senderAddress)).size, 70);
	assert.ok(Math.max(...sizes.map(([, n]) => n)) < 100, `max binds ${Math.max(...sizes.map(([, n]) => n))}`);
	const latest = sizes.filter(([sql]) => /^select "id", "from_addr"/.test(sql));
	assert.equal(latest.length, 70, "50 + 20 latest-message statements");
	assert.ok(latest.every(([, n]) => n === 3));
});

test("GET shows overrides and the unsubscribe record, and flags a sender still mailing more than 2 days after", async (t) => {
	const { database, add } = await fixture(t);
	add("a1", { at: now() - 10 * DAY });
	add("a2", { at: now() - 1 * DAY });
	add("b1", { sender: "calm@x.com", at: now() - 20 * DAY });
	add("c1", { sender: "soon@x.com", at: now() - 2 * DAY });
	database.db.exec(`
		INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, unsubscribed_at, updated_at) VALUES
			('p1', 'a', 'news@acme.com', 'promotions', ${now() - 5 * DAY}, 1),
			('p2', 'a', 'calm@x.com', 'inbox', ${now() - 10 * DAY}, 1),
			('p3', 'a', 'soon@x.com', NULL, ${now() - 2 * DAY - 3600}, 1);
	`);
	const rows = Object.fromEntries((await list("?mailboxId=a")).body.senders.map((row) => [row.senderAddress, row]));
	assert.equal(rows["news@acme.com"].categoryOverride, "promotions");
	assert.equal(rows["news@acme.com"].stillSending, true);
	assert.equal(typeof rows["news@acme.com"].unsubscribedAt, "string");
	assert.equal(rows["calm@x.com"].categoryOverride, "inbox");
	assert.equal(rows["calm@x.com"].stillSending, false);
	assert.equal(rows["soon@x.com"].stillSending, false);
});

test("a read-only delegate can read the list; an unrelated user cannot see a mailbox they have no access to", async (t) => {
	const { add } = await fixture(t, { delegatePermission: "read_only" });
	add("x1", { mailbox: "s" });
	as(DELEGATE);
	assert.equal((await list("?mailboxId=s")).body.total, 1);
	assert.deepEqual((await list("?mailboxId=a")).body, { senders: [], total: 0 });
});

test("Trash all preview reports count, willChange and olderLeft without writing", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 3; i++) add(`n${i}`, { age: 2 });
	for (let i = 0; i < 2; i++) add(`old${i}`, { age: 100 });
	add("star", { starred: 1 });
	const result = await trash({ mailboxId: "a", senderAddress: "News@Acme.com", previewOnly: true });
	assert.deepEqual(result, { status: 200, body: { count: 3, willChange: 3, olderLeft: 2 } });
	assert.equal(count(database, "status = 'trash'"), 0);
});

test("Trash all moves at most 500 recent rows in chunks under 100 parameters, reports the real count, and audits after the update", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 530; i++) add(`n${i}`, { age: 1 });
	add("star", { starred: 1 });
	add("old", { age: 120 });
	add("other", { sender: "other@acme.com" });
	database.db.exec("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f', 'u', 'a', 'F', 1)");
	add("filed");
	database.db.exec("UPDATE messages SET folder_id = 'f' WHERE id = 'filed'");
	const events = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			if (/^update "?messages"?/i.test(sql)) events.push(["update", values.length]);
			if (/^insert into "?audit_logs"?/i.test(sql)) events.push(["audit", values]);
			return bind(...values);
		};
		return statement;
	};
	const result = await trash({ mailboxId: "a", senderAddress: "news@acme.com" });
	assert.deepEqual(result, { status: 200, body: { changed: m.MAX_SWEEP_ROWS, remaining: 31 } });
	assert.equal(count(database, "status = 'trash'"), 500);
	assert.equal(count(database, "id IN ('star','old','other','filed') AND status = 'trash'"), 0);
	const updates = events.filter(([kind]) => kind === "update");
	assert.ok(updates.length >= 6 && Math.max(...updates.map(([, n]) => n)) < 100, `update binds ${updates.map(([, n]) => n)}`);
	const auditIndex = events.findIndex(([kind]) => kind === "audit");
	assert.ok(auditIndex === events.length - 1, "audit is written after the last update");
	const audit = database.db.prepare("SELECT action, metadata FROM audit_logs").get();
	assert.equal(audit.action, "email.sender_trash");
	assert.equal(JSON.parse(audit.metadata).count, 500);
	// the newest rows go first: what is left is the oldest of the recent ones
	assert.equal(count(database, "status = 'received' AND sender_address = 'news@acme.com' AND id LIKE 'n%' AND created_at > (SELECT min(created_at) FROM messages WHERE status = 'trash')"), 0);
});

test("Trash all counts only rows it really changed when a row is starred between the select and the update", async (t) => {
	const { database, add } = await fixture(t);
	for (let i = 0; i < 3; i++) add(`n${i}`, { age: 1 });
	const prepare = database.prepare.bind(database);
	let raced = false;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			if (!raced && /^update "?messages"?/i.test(sql)) { raced = true; database.db.exec("UPDATE messages SET starred = 1 WHERE id = 'n1'"); }
			return bind(...values);
		};
		return statement;
	};
	const result = await trash({ mailboxId: "a", senderAddress: "news@acme.com" });
	assert.deepEqual(result.body, { changed: 2, remaining: 0 });
	const audit = database.db.prepare("SELECT metadata FROM audit_logs").get();
	assert.equal(JSON.parse(audit.metadata).count, 2);
});

test("Trash all needs full access, a same-origin request and a session; a read-only delegate gets 403 and nothing changes", async (t) => {
	const { database, add } = await fixture(t, { delegatePermission: "read_only" });
	add("n", { mailbox: "s" });
	add("m1");
	as(DELEGATE);
	assert.equal((await trash({ mailboxId: "s", senderAddress: "news@acme.com" })).status, 403);
	assert.equal((await trash({ mailboxId: "a", senderAddress: "news@acme.com" })).status, 404);
	as(OWNER);
	assert.equal((await trash({ mailboxId: "a", senderAddress: "news@acme.com" }, { origin: false })).status, 403);
	assert.equal((await trash({ mailboxId: "a" })).status, 400);
	as(null);
	assert.equal((await trash({ mailboxId: "a", senderAddress: "news@acme.com" })).status, 401);
	assert.equal(count(database, "status = 'trash'"), 0);
});

test("Trash all answers 409 PROMOTIONS_OFF when the mailbox mode is off", async (t) => {
	const { add } = await fixture(t, { mode: null });
	add("m1");
	const result = await trash({ mailboxId: "a", senderAddress: "news@acme.com" });
	assert.equal(result.status, 409);
	assert.equal(result.body.code, "PROMOTIONS_OFF");
});

// --- unsubscribe route records the unsubscribe -----------------------------------------------------------------

const oneClickRaw = "DKIM-Signature: v=1; d=acme.com; h=from:list-unsubscribe; b=q\r\nList-Unsubscribe: <https://acme.com/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nFrom: Acme News <news@acme.com>\r\n\r\nbody";
const mailtoRaw = "List-Unsubscribe: <mailto:unsub@acme.com?subject=remove>\r\nFrom: Acme News <news@acme.com>\r\n\r\nbody";
const linkRaw = "List-Unsubscribe: <https://acme.com/page>\r\nFrom: Acme News <news@acme.com>\r\n\r\nbody";

async function unsubscribeFixture(t, raw) {
	const f = await fixture(t);
	f.add("msg", {});
	f.database.db.exec("UPDATE messages SET raw_r2_key = 'raw/msg' WHERE id = 'msg'");
	globalThis.__mailflareNodeEnv.BUCKET = { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(raw).buffer }) };
	globalThis.__sent = 0;
	globalThis.__mailFails = false;
	const fetches = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => { fetches.push(String(url)); return new Response(null, { status: globalThis.__fetchStatus ?? 200 }); };
	globalThis.__fetchStatus = 200;
	t.after(() => { globalThis.fetch = realFetch; });
	return { ...f, fetches };
}
const unsubscribedRows = (database) => database.db.prepare("SELECT mailbox_id, sender_address, category_override, unsubscribed_at, updated_by_user_id FROM mailbox_sender_preferences").all();

test("a one-click unsubscribe records unsubscribed_at on the sender's preference row and keeps an existing override", async (t) => {
	const { database, fetches } = await unsubscribeFixture(t, oneClickRaw);
	database.db.exec("INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, updated_at) VALUES ('p', 'a', 'news@acme.com', 'promotions', 1)");
	const result = await unsubscribe("msg");
	assert.equal(result.body.method, "one-click");
	assert.equal(fetches.length, 1);
	const [row] = unsubscribedRows(database);
	assert.equal(row.category_override, "promotions");
	assert.ok(Math.abs(row.unsubscribed_at - now()) < 5);
	assert.equal(unsubscribedRows(database).length, 1);
});

test("a mailto unsubscribe creates the preference row with no override", async (t) => {
	const { database } = await unsubscribeFixture(t, mailtoRaw);
	const result = await unsubscribe("msg");
	assert.equal(result.body.method, "mailto");
	assert.equal(globalThis.__sent, 1);
	const [row] = unsubscribedRows(database);
	assert.equal(row.sender_address, "news@acme.com");
	assert.equal(row.category_override, null);
	assert.ok(row.unsubscribed_at > 0);
});

test("a link fallback is not recorded: the user has not finished unsubscribing yet", async (t) => {
	const { database } = await unsubscribeFixture(t, linkRaw);
	const result = await unsubscribe("msg");
	assert.equal(result.body.method, "link");
	assert.deepEqual(unsubscribedRows(database), []);
});

test("a failed one-click or mailto records nothing", async (t) => {
	const { database } = await unsubscribeFixture(t, mailtoRaw);
	globalThis.__mailFails = true;
	assert.notEqual((await unsubscribe("msg")).body.method, "mailto");
	assert.deepEqual(unsubscribedRows(database), []);
});

test("recording the unsubscribe never fails it: a missing table is tolerated, so is a read-only delegate", async (t) => {
	const { database } = await unsubscribeFixture(t, mailtoRaw);
	database.db.exec("DROP TABLE mailbox_sender_preferences");
	const result = await unsubscribe("msg");
	assert.deepEqual([result.status, result.body.method], [200, "mailto"]);
});

test("unsubscribe_and_trash sweeps the exact sender only (not a look-alike address) and reports trashedCount", async (t) => {
	const { database, add } = await unsubscribeFixture(t, mailtoRaw);
	add("sibling", { category: null });
	add("lookalike", { sender: "othernews@acme.com", from: "othernews@acme.com", category: null });
	const result = await unsubscribe("msg", { action: "unsubscribe_and_trash" });
	assert.equal(result.body.trashedCount, 2);
	assert.equal(count(database, "status = 'trash'"), 2);
	assert.equal(unsubscribedRows(database).length, 1);
});
